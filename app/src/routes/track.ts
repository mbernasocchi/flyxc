import express, { Request, Response, Router } from 'express';
import { UploadedFile } from 'express-fileupload';
import * as protos from 'flyxc/common/protos/track';
import { diffDecodeAirspaces } from 'flyxc/common/src/runtime-track';
import {
  retrieveMetaTrackGroupByUrl,
  retrieveMetaTrackGroupsByIds,
  retrieveRecentTracks,
  TrackEntity,
} from 'flyxc/common/src/track-entity';

import { Datastore } from '@google-cloud/datastore';

import { parse, parseFromUrl } from '../parser/parser';

export function getTrackRouter(): Router {
  const router = express.Router();

  // Retrieves tracks by url.
  router.get('/_download', async (req: Request, res: Response) => {
    const urls = [].concat(req.query.track as any);
    const trackGroups: protos.MetaTrackGroup[] = await Promise.all(urls.map(parseFromUrl));
    sendTracks(res, trackGroups);
  });

  // Retrieves tracks by datastore ids.
  router.get('/_history', async (req: Request, res: Response) => {
    const ids = [].concat(req.query.id as any);
    const trackGroups: protos.MetaTrackGroup[] = await retrieveMetaTrackGroupsByIds(ids);
    sendTracks(res, trackGroups);
  });

  // Retrieves the list of tracks.
  // The `tracks` query parameter set the number of tracks to retrieve.
  router.get('/_archives', async (req: Request, res: Response) => {
    const tracks: TrackEntity[] = await retrieveRecentTracks((req.query.tracks as any) || 10);

    res.json(
      tracks.map((track) => ({
        id: track[Datastore.KEY]?.id,
        city: track.city,
        country: track.country,
        path: track.path,
        created: track.created,
      })),
    );
  });

  // Upload tracks to the database.
  router.post('/_upload', async (req: Request, res: Response) => {
    if (req.files?.track) {
      const fileObjects: UploadedFile[] = [].concat(req.files.track as any);
      const files: string[] = fileObjects.map((file) => file.data.toString());
      const tracks: protos.MetaTrackGroup[] = await Promise.all(files.map((file) => parse(file)));
      sendTracks(res, tracks);
      return;
    }
    res.sendStatus(400);
  });

  // Retrieves track metadata by datastore ids.
  router.get('/_metadata', async (req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');
    if (req.query.ids == null || typeof req.query.ids != 'string') {
      res.sendStatus(204);
      return;
    }
    const ids = req.query.ids.split(',');
    const trackGroups: protos.MetaTrackGroup[] = await retrieveMetaTrackGroupsByIds(ids);
    const processedGroups: protos.MetaTrackGroup[] = [];
    trackGroups.forEach((group) => {
      if (group != null && group.numPostprocess > 0) {
        // Delete the tracks and keep only metadata.
        group.trackGroupBin = undefined;
        processedGroups.push(group);
      }
    });
    if (processedGroups.length > 0) {
      sendTracks(res, processedGroups);
    } else {
      res.sendStatus(204);
    }
  });

  // Returns the airspaces info for the first track in the group as JSON.
  // Returns 404 if the info are not available (/not ready yet).
  router.get('/_airspaces', async (req: Request, res: Response) => {
    res.set('Access-Control-Allow-Origin', '*');
    const url = req.query.track;
    if (typeof url === 'string') {
      const metaGroup = await retrieveMetaTrackGroupByUrl(url);
      if (metaGroup?.airspacesGroupBin) {
        const aspGroup = protos.AirspacesGroup.fromBinary(new Uint8Array(metaGroup.airspacesGroupBin));
        if (aspGroup?.airspaces) {
          const airspaces = diffDecodeAirspaces(aspGroup.airspaces[0]);
          res.json(airspaces);
          return;
        }
      }
    }
    res.sendStatus(404);
  });

  return router;
}

// Sends the tracks as an encoded protocol buffer.
function sendTracks(res: Response, metaGroups: protos.MetaTrackGroup[]): void {
  if (metaGroups.length == 0) {
    res.sendStatus(400);
    return;
  }
  const metaTrackGroupsBin = metaGroups.map((group) => protos.MetaTrackGroup.toBinary(group));
  res.set('Content-Type', 'application/x-protobuf');
  res.send(Buffer.from(protos.MetaTracks.toBinary({ metaTrackGroupsBin })));
}
