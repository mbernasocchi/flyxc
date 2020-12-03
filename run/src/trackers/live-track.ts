import * as protos from 'flyxc/common/protos/live-track';
import { idFromKey } from 'flyxc/common/src/datastore';
import {
  getTrackerFlags as getLiveTrackFlags,
  LIVE_RETENTION_SEC,
  mergeLiveTracks,
  removeBeforeFromLiveTrack,
  trackerDisplayNames,
  trackerPropNames,
  Trackers,
} from 'flyxc/common/src/live-track';
import { LIVE_TRACK_TABLE, LiveTrackEntity, TrackerEntity } from 'flyxc/common/src/live-track-entity';
import { round } from 'flyxc/common/src/math';

import { Datastore, Key } from '@google-cloud/datastore';

import * as flyme from './flyme';
import * as inreach from './inreach';
import * as skylines from './skylines';
import * as spot from './spot';

// TODO: one instance ?
const datastore = new Datastore();

export interface LivePoint {
  lat: number;
  lon: number;
  alt: number;
  // Timestamps in milliseconds.
  timestamp: number;
  device: Trackers;
  // Whether the gps fix is invalid.
  // undefined or null is considered valid (only false is invalid).
  valid?: boolean | null;

  // Optional fields.
  emergency?: boolean | null;
  message?: string | null;
  speed?: number | null;
  lowBattery?: boolean | null;
}

// Make a track for a list of points.
// The track is in chronological order (oldest point first).
export function makeLiveTrack(points: LivePoint[]): protos.LiveTrack {
  points.sort((a, b) => a.timestamp - b.timestamp);

  const track = protos.LiveTrack.create();

  points.forEach((point, index) => {
    track.lat.push(round(point.lat, 5));
    track.lon.push(round(point.lon, 5));
    track.alt.push(Math.round(point.alt));
    track.timeSec.push(Math.round(point.timestamp / 1000));
    track.flags.push(
      getLiveTrackFlags({
        valid: point.valid !== false,
        emergency: point.emergency === true,
        lowBat: point.lowBattery === true,
        device: point.device,
      }),
    );
    let hasExtra = false;
    const extra: protos.LiveExtra = {};
    if (point.speed != null) {
      extra.speed = round(point.speed, 1);
      hasExtra = true;
    }
    if (point.message != null) {
      extra.message = point.message;
      hasExtra = true;
    }
    if (hasExtra) {
      track.extra[index] = extra;
    }
  });

  return track;
}

// Error thrown by the parsers.
export class ParseError extends Error {
  constructor(message: string) {
    super('[Parse Error]: ' + message);
  }
}

// The error and requests fields has
// - 3 upper digits for the errors,
// - 3 lower digits for the requests.
//
// 005230 means that there has been 5 errors and 230 requests.
//
// When any of the field overflow they are both divided by 2 to keep some history.
export function incrementRequests(errorAndRequests: number | undefined, value: { isError: boolean }): number {
  errorAndRequests ??= 0;
  let errors = Math.round(errorAndRequests / 1000);
  if (value.isError === true) {
    errors++;
  }
  let requests = (errorAndRequests % 1000) + 1;
  if (requests >= 1000 || errors >= 1000) {
    errors >>= 1;
    requests >>= 1;
  }

  return errors * 1000 + requests;
}

export interface TrackerForUpdate {
  [Datastore.KEY]: Key;
  account: string;
  updated: number;
}

// Returns the list of trackers to update.
// Only consider the trackers updated before `updatedBeforeMicros`.
//
// Only the account and updated timestamp are returned;
export async function getTrackersToUpdate(
  deviceType: Trackers,
  updatedBeforeMicros: number,
  limit?: number,
): Promise<TrackerForUpdate[]> {
  const trackerProp = trackerPropNames[deviceType];
  const accountPath = `${trackerProp}.account`;
  const updatedPath = `${trackerProp}.updated`;
  const enabledPath = `${trackerProp}.enabled`;

  try {
    let query = datastore
      .createQuery(LIVE_TRACK_TABLE)
      .select([accountPath, updatedPath])
      .filter('enabled', true)
      .filter(enabledPath, true)
      .filter(updatedPath, '<', updatedBeforeMicros)
      .order(updatedPath, { descending: false });

    if (limit != null) {
      query = query.limit(limit);
    }

    const response = await datastore.runQuery(query);

    return response[0].map((entity) => ({
      [Datastore.KEY]: entity[Datastore.KEY],
      account: entity[accountPath],
      updated: entity[updatedPath],
    }));
  } catch (e) {
    console.error(`Error querying ${trackerPropNames[deviceType]} trackers: "${e}"`);
    return [];
  }
}

// Updates for a single live track.
export interface TrackUpdate {
  // Track delta since last update.
  track?: protos.LiveTrack;
  // There must be an error message is the update failed.
  error?: string;
  // Timestamp of the update.
  updated: number;
}

// Update for a tracker type.
export interface TrackerUpdate {
  deviceType: Trackers;
  // Map of id to track update.
  tracks: Map<number, TrackUpdate>;
  // Map of id to account.
  // Used to update an account when resolved by the tracker code.
  // false disabled the account
  accounts?: Map<number, string | false>;
  errors: string[];
  durationSec: number;
}

// Update all the trackers:
// - Fetch the deltas,
// - Merge with existing tracks,
// - Save to datastore.
export async function updateTrackers(): Promise<LiveTrackEntity[]> {
  const start = Date.now();
  const refreshes = await Promise.allSettled([inreach.refresh(), spot.refresh(), skylines.refresh(), flyme.refresh()]);

  const updates: TrackerUpdate[] = [];
  // Collect all the ids that have been updated.
  const idSet = new Set<number>();
  const batchEntities: LiveTrackEntity[] = [];

  refreshes.forEach((result, i: number) => {
    if (result.status == 'fulfilled') {
      const update = result.value;
      updates.push(update);
      [...update.tracks.keys()].forEach((id) => idSet.add(id));
      console.log(
        `[${trackerDisplayNames[update.deviceType]}] Update ${update.tracks.size} devices in ${update.durationSec}s`,
      );
      if (update.errors.length > 0) {
        console.error(`[${trackerDisplayNames[update.deviceType]}] Update error: ${update.errors.join(`, `)}`);
      }
    } else {
      console.error(`Tracker update #${i} error: ${result.reason}`);
    }
  });

  console.log(`Updates fetched in ${Math.round((Date.now() - start) / 1000)}s`);

  const ids = [...idSet];
  const startSave = Date.now();
  const savePromises: Promise<boolean>[] = [];

  while (ids.length > 0) {
    const batchIds = ids.splice(0, 20);
    const batchKeys = batchIds.map((id) => datastore.key([LIVE_TRACK_TABLE, id]));
    savePromises.push(saveTrackersWithRetries(batchKeys, updates));
  }

  const saveResults = await Promise.allSettled(savePromises);
  let saveErrors = 0;
  saveResults.forEach((result) => {
    if (result.status == 'fulfilled' && result.value == false) {
      saveErrors++;
    }
    if (result.status == 'rejected') {
      // This should only happen if the roolback throws.
      console.error(`Batch transactions failure: ${result.reason}`);
      saveErrors++;
    }
  });

  if (saveErrors > 0) {
    console.error(`${saveErrors} batch save errors`);
  }

  console.log(`Trackers updated in ${Math.round((Date.now() - startSave) / 1000)}s`);
  return batchEntities;
}

// Updates the tracker in a transaction.
//
// The transaction might fail when a user saves concurrently update their settings.
// The transaction is retried in such a case.
//
// Returns whether the transaction went through ok.
async function saveTrackersWithRetries(keys: Key[], updates: TrackerUpdate[], retries = 3): Promise<boolean> {
  while (retries-- > 0) {
    const transaction = datastore.transaction();
    try {
      await transaction.run();

      const [entities]: LiveTrackEntity[][] = await datastore.get(keys);

      // Apply the updates.
      entities.forEach((entity: LiveTrackEntity) => {
        const id = idFromKey(entity[Datastore.KEY]);
        let track = entity.track ? protos.LiveTrack.fromBinary(entity.track) : protos.LiveTrack.create();

        updates.forEach((update) => {
          const trackerProp = trackerPropNames[update.deviceType];
          const tracker: TrackerEntity = (entity as any)[trackerProp];

          // Update the tracker with the new points.
          const delta = update.tracks.get(id);
          if (delta) {
            tracker.updated = delta.updated;
            const isError = delta.error != null;
            tracker.errors_requests = incrementRequests(tracker.errors_requests, { isError });
            if (delta.track) {
              track = mergeLiveTracks(track, delta.track);
            }
          }

          // We might need to update the account.
          const account = update.accounts?.get(id);
          if (account != null) {
            if (account === false) {
              tracker.enabled = false;
            } else {
              tracker.account = account;
            }
          }
        });

        track = removeBeforeFromLiveTrack(track, Date.now() / 1000 - LIVE_RETENTION_SEC);
        entity.track = Buffer.from(protos.LiveTrack.toBinary(track));
        if (track.timeSec.length > 0) {
          entity.last_fix_sec = Math.max(entity.last_fix_sec, track.timeSec[track.timeSec.length - 1]);
        }

        transaction.save({
          key: entity[Datastore.KEY],
          data: entity,
          excludeFromIndexes: ['track'],
        });
      });

      await transaction.commit();

      return true;
    } catch (e) {
      console.error(`Transaction error: ${e}, retries = ${retries}`);
      await transaction.rollback();
    }
  }

  return false;
}
