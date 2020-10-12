import {
  addAirspaces,
  addGroundAltitude,
  createRuntimeTracks,
  createTrackId,
  extractGroupId,
  ProtoAirspaces,
  ProtoGroundAltitude,
  ProtoMetaTrackGroup,
  RuntimeTrack,
} from 'flyxc/common/track';
import * as protos from 'flyxc/common/track_proto';
import Pbf from 'pbf';

import { createAsyncThunk, createEntityAdapter, createSlice, EntityState, PayloadAction } from '@reduxjs/toolkit';

import { addUrlParamValue, deleteUrlParamValue, ParamNames } from '../logic/history';
import * as msg from '../logic/messages';
import * as TrackWorker from '../workers/track';
import { AppDispatch, RootState } from './store';

const FETCH_EVERY_SECONDS = 15;
export const FETCH_FOR_MINUTES = 3;

const trackAdapter = createEntityAdapter<RuntimeTrack>({
  selectId: (track) => track.id,
  sortComparer: (a, b) => a.ts[0] - b.ts[0],
});

export type TrackState = {
  currentTrackId?: string;
  fetching: boolean;
  metadata: {
    // Map from track id to when we started fetching metadata.
    groupIdToStart: { [id: string]: number };
    // True when fetching metadata is pending.
    // It is pending for FETCH_EVERY_SECONDS.
    fetchPending: boolean;
  };
  tracks: EntityState<RuntimeTrack>;
};

const initialState: TrackState = {
  currentTrackId: undefined,
  fetching: false,
  metadata: {
    // map group ids to their fetch timestamp.
    groupIdToStart: {},
    fetchPending: false,
  },
  tracks: trackAdapter.getInitialState(),
};

const fetchPendingServerMetadata = createAsyncThunk(
  'track/fetchMetadata',
  async (_: undefined, api) => {
    api.dispatch(trackSlice.actions.setFetchingMetadata(true));
    await new Promise((resolve) => setTimeout(resolve, FETCH_EVERY_SECONDS));
    api.dispatch(trackSlice.actions.timeoutPendingServerMetadata());
    const state = api.getState() as RootState;
    const groupIds = Object.keys(state.track.metadata.groupIdToStart);
    let output: ArrayBuffer | undefined;
    api.dispatch(trackSlice.actions.setFetchingMetadata(false));
    if (groupIds.length) {
      try {
        const response = await fetch(`_metadata?ids=${groupIds.join(',')}`);
        // The server returns a 204 (No content) status code when the metadata is not ready.
        if (response.status == 200) {
          output = await response.arrayBuffer();
        }
      } catch (e) {}
      api.dispatch(fetchPendingServerMetadata());
    }
    return output;
  },
  {
    condition: (_: undefined, api) => {
      // Only schedule a fetch when none is pending.
      const state = api.getState() as RootState;
      return !state.track.metadata.fetchPending;
    },
  },
);

// Lazily created worker for client side track processing.
let trackWorker: Worker | undefined;

function getTrackWorker(dispatch: AppDispatch): Worker {
  if (!trackWorker) {
    trackWorker = new Worker('js/workers/track.js');
    trackWorker.onmessage = (msg: MessageEvent<TrackWorker.Response>) => {
      dispatch(trackSlice.actions.patchTrack(msg.data));
    };
  }
  return trackWorker;
}

type FetchTrackParams = {
  url: string;
  options?: RequestInit;
};

// Fetches a track group.
//
// Triggers:
// - the track worker,
// - the server metadata request.
//
// Returns the tracks.
export const fetchTrack = createAsyncThunk('track/fetch', async (params: FetchTrackParams, api) => {
  const response = await fetch(params.url, params.options);
  const metaTracks = await response.arrayBuffer();
  const groupIds = new Set<number>();
  const tracks = createRuntimeTracks(metaTracks);

  tracks.forEach((track) => {
    const groupId = extractGroupId(track.id);
    groupIds.add(groupId);
    addUrlParamValue(ParamNames.groupId, String(groupId));
    // Trigger the worker post-processing.
    getTrackWorker(api.dispatch).postMessage(track);
    if (!track.isPostProcessed) {
      api.dispatch(trackSlice.actions.addPendingServerMetadata(groupId));
    }
  });
  api.dispatch(trackSlice.actions.addTracks(tracks));
  api.dispatch(fetchPendingServerMetadata());
  msg.trackGroupsAdded.emit(Array.from(groupIds));
  return tracks;
});

const trackSlice = createSlice({
  name: 'track',
  initialState,
  reducers: {
    addTracks: (state, action: PayloadAction<RuntimeTrack[]>) => {
      const hasTrack = state.currentTrackId != null;
      trackAdapter.addMany(state.tracks, action);
      if (!hasTrack) {
        state.currentTrackId = String(state.tracks.ids[0]);
      }
    },
    removeTracksByGroupIds: (state, action: PayloadAction<number[]>) => {
      const groupIds = action.payload.map((v) => String(v));
      groupIds.forEach((groupId) => deleteUrlParamValue(ParamNames.groupId, groupId));
      const trackIds = state.tracks.ids.filter((id) => groupIds.some((groupId) => String(id).startsWith(groupId)));
      trackAdapter.removeMany(state.tracks, trackIds);
      if (state.tracks.ids.length == 0) {
        state.currentTrackId = undefined;
      } else if (state.currentTrackId != null) {
        if (state.tracks.ids.indexOf(state.currentTrackId) == -1) {
          state.currentTrackId = String(state.tracks.ids[0]);
        }
      }
    },
    setCurrentTrackId: (state, action: PayloadAction<string | undefined>) => {
      state.currentTrackId = action.payload;
    },
    selectNextTrack: (state) => {
      if (state.currentTrackId != null && state.tracks.ids.length > 0) {
        const index = state.tracks.ids.indexOf(state.currentTrackId);
        state.currentTrackId = String(state.tracks.ids[(index + 1) % state.tracks.ids.length]);
      }
    },
    patchTrack: (state, action: PayloadAction<Partial<RuntimeTrack> & Pick<RuntimeTrack, 'id'>>) => {
      const update = action.payload;
      trackAdapter.updateOne(state.tracks, {
        id: update.id,
        changes: update,
      });
    },
    setFetchingMetadata: (state, action: PayloadAction<boolean>) => {
      state.metadata.fetchPending = action.payload;
    },
    // Add a group id to the schedule.
    addPendingServerMetadata: (state, action: PayloadAction<number>) => {
      const groupId = action.payload;
      if (!(groupId in state.metadata.groupIdToStart)) {
        state.metadata.groupIdToStart[groupId] = Date.now();
      }
    },
    // Remove old requests that haven't been fulfilled.
    timeoutPendingServerMetadata: (state) => {
      const groupIdToStart = state.metadata.groupIdToStart;
      const dropBefore = Date.now() - FETCH_FOR_MINUTES * 60 * 1000;
      for (const [id, startedOn] of Object.entries(groupIdToStart)) {
        if (startedOn <= dropBefore) {
          delete groupIdToStart[id];
        }
      }
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchTrack.pending, (state) => {
        state.fetching = true;
      })
      .addCase(fetchTrack.fulfilled, (state, action: PayloadAction<RuntimeTrack[]>) => {
        state.fetching = false;
        trackAdapter.addMany(state.tracks, action);
      })
      .addCase(fetchTrack.rejected, (state) => {
        state.fetching = false;
      })
      .addCase(fetchPendingServerMetadata.fulfilled, (state, action: PayloadAction<ArrayBuffer | undefined>) => {
        state.metadata.fetchPending = false;
        const metaTracks = action.payload;
        if (metaTracks) {
          // Decode the meta groups.
          const metaGroups: ProtoMetaTrackGroup[] = (protos.MetaTracks as any)
            .read(new Pbf(metaTracks))
            .meta_track_groups_bin.map((metaGroupBin: any) => {
              return (protos.MetaTrackGroup as any).read(new Pbf(metaGroupBin));
            });
          // Patch any tack from the meta groups.
          metaGroups.forEach((metaGroup) => {
            const groupId = metaGroup.id;
            delete state.metadata.groupIdToStart[groupId];
            // Patch the ground altitude.
            if (metaGroup.ground_altitude_group_bin) {
              const gndAltitudes: ProtoGroundAltitude[] = (protos.GroundAltitudeGroup as any).read(
                new Pbf(metaGroup.ground_altitude_group_bin),
              ).ground_altitudes;

              gndAltitudes.forEach((gndAlt, index) => {
                const id = createTrackId(groupId, index);
                const track = state.tracks.entities[id];
                if (track != null) {
                  addGroundAltitude(track, gndAlt);
                }
              });
            }
            // Patch the airspaces.
            if (metaGroup.airspaces_group_bin) {
              const airspaces: ProtoAirspaces[] = (protos.AirspacesGroup as any).read(
                new Pbf(metaGroup.airspaces_group_bin),
              ).airspaces;
              airspaces.forEach((asp, index) => {
                const id = createTrackId(groupId, index);
                const track = state.tracks.entities[id];
                if (track != null) {
                  addAirspaces(track, asp);
                }
              });
            }
          });
        }
      });
  },
});

export const reducer = trackSlice.reducer;
export const { removeTracksByGroupIds, setCurrentTrackId, selectNextTrack } = trackSlice.actions;
export const trackAdapterSelector = trackAdapter.getSelectors((state: RootState) => state.track.tracks);