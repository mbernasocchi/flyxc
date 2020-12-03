import { findClosestFix } from 'flyxc/common/src/distance';
import { pixelCoordinates } from 'flyxc/common/src/proj';
import { LatLon, LatLonZ, RuntimeTrack } from 'flyxc/common/src/runtime-track';
import {
  customElement,
  html,
  internalProperty,
  LitElement,
  property,
  PropertyValues,
  TemplateResult,
} from 'lit-element';
import { repeat } from 'lit-html/directives/repeat';
import { UnsubscribeHandle } from 'micro-typed-events';
import { connect } from 'pwa-helpers';

import { getApiKey } from '../../../apikey';
import { getUrlParamValues, ParamNames } from '../../logic/history';
import * as msg from '../../logic/messages';
import { setApiLoading, setTimestamp } from '../../redux/app-slice';
import { setCurrentLocation } from '../../redux/location-slice';
import * as sel from '../../redux/selectors';
import { RootState, store } from '../../redux/store';
import { setCurrentTrackId } from '../../redux/track-slice';
import { ControlsElement } from './controls-element';
import { LineElement } from './line-element';
import { MarkerElement } from './marker-element';
import { PlannerElement } from './planner-element';
import { SegmentsElement } from './segments-element';
import { TopoEu, TopoFrance, TopoOtm, TopoSpain } from './topo-elements';
import { TrackingElement } from './tracking-element';

// Prevent tree-shaking components by exporting them
export {
  ControlsElement,
  LineElement,
  MarkerElement as GmMarkerElement,
  PlannerElement,
  SegmentsElement,
  TopoEu,
  TopoSpain,
  TopoFrance,
  TopoOtm,
  TrackingElement,
};

// Load the google maps api
declare global {
  interface Window {
    initMap: () => void;
  }
}

let apiPromise: Promise<void> | undefined;

// Load google maps
function loadApi(): Promise<void> {
  if (!apiPromise) {
    let apiLoaded = (): void => undefined;
    window.initMap = () => apiLoaded();
    apiPromise = new Promise<void>((resolve) => (apiLoaded = resolve));
    const tracks = getUrlParamValues(ParamNames.trackUrl);
    const loader = document.createElement('script');
    loader.src = `https://maps.googleapis.com/maps/api/js?key=${getApiKey(
      'gmaps',
      tracks[0],
    )}&libraries=geometry&callback=initMap&v=beta&map_ids=997ff70df48844a5`;
    document.head.appendChild(loader);
  }
  return apiPromise;
}

@customElement('map-element')
export class MapElement extends connect(store)(LitElement) {
  @property({ attribute: false })
  map: google.maps.Map | undefined;

  @internalProperty()
  private tracks: RuntimeTrack[] = [];
  @internalProperty()
  private timestamp = 0;
  @internalProperty()
  private fullscreen = false;

  private centerMap = false;
  private lockPanBefore = 0;
  private subscriptions: UnsubscribeHandle[] = [];
  private readonly adRatio = store.getState().browser.isSmallScreen ? 0.7 : 1;

  stateChanged(state: RootState): void {
    this.tracks = sel.tracks(state);
    this.timestamp = state.app.timestamp;
    // In full screen mode the gesture handling must be greedy.
    // Using ctrl (+ scroll) is unnecessary as thr page can not scroll anyway.
    this.fullscreen = state.browser.isFullscreen;
    this.centerMap = state.app.centerMap;
  }

  shouldUpdate(changedProps: PropertyValues): boolean {
    const now = Date.now();
    if (this.map) {
      if (this.tracks.length && this.centerMap && changedProps.has('timestamp') && now > this.lockPanBefore) {
        this.lockPanBefore = now + 50;
        const zoom = this.map.getZoom();
        const currentPosition = sel.getTrackLatLonAlt(store.getState())(this.timestamp) as LatLonZ;
        const { x, y } = pixelCoordinates(currentPosition, zoom).world;
        const bounds = this.map.getBounds() as google.maps.LatLngBounds;
        const sw = bounds.getSouthWest();
        const { x: minX, y: maxY } = pixelCoordinates({ lat: sw.lat(), lon: sw.lng() }, zoom).world;
        const ne = bounds.getNorthEast();
        const { x: maxX, y: minY } = pixelCoordinates({ lat: ne.lat(), lon: ne.lng() }, zoom).world;

        if (x - minX < 100 || y - minY < 100 || maxX - x < 100 || maxY - y < 100) {
          this.map.panTo({ lat: currentPosition.lat, lng: currentPosition.lon });
        }
      }
      if (changedProps.has('fullscreen')) {
        this.map.setOptions({ gestureHandling: this.fullscreen ? 'greedy' : 'auto' });
        changedProps.delete('fullscreen');
      }
    }
    return super.shouldUpdate(changedProps);
  }

  connectedCallback(): void {
    super.connectedCallback();
    store.dispatch(setApiLoading(true));
    loadApi().then((): void => {
      const options: google.maps.MapOptions = {
        center: { lat: 45, lng: 0 },
        zoom: 5,
        minZoom: 3,
        // Google maps terrain is only available up to zoom level 17.
        maxZoom: 17,
        mapTypeId: google.maps.MapTypeId.TERRAIN,
        scaleControl: true,
        fullscreenControl: false,
        streetViewControl: false,
        mapTypeControlOptions: {
          mapTypeIds: [
            'terrain',
            'satellite',
            TopoOtm.mapTypeId,
            TopoFrance.mapTypeId,
            TopoFrance.mapTypeIdScan,
            TopoEu.mapTypeId,
            TopoSpain.mapTypeId,
          ],
          style: google.maps.MapTypeControlStyle.DROPDOWN_MENU,
        },
      };

      // Do not enable the webgl renderer on mobile devices as it is slow to load.
      if (!store.getState().browser.isMobile) {
        (options as any).mapId = '997ff70df48844a5';
        (options as any).useStaticMap = true;
      }

      this.map = new google.maps.Map(this.querySelector('#map') as Element, options);

      const controls = document.createElement('controls-element') as ControlsElement;
      controls.map = this.map;
      this.map.controls[google.maps.ControlPosition.TOP_RIGHT].push(controls);

      const ad = document.createElement('a');
      ad.setAttribute('href', 'https://www.flyozone.com/');
      ad.setAttribute('target', '_blank');
      ad.innerHTML = `<img width="${Math.round(210 * this.adRatio)}" height="${Math.round(
        35 * this.adRatio,
      )}" src="img/ozone.svg">`;
      this.map.controls[google.maps.ControlPosition.BOTTOM_CENTER].push(ad);

      this.map.addListener('click', (e: google.maps.MouseEvent) => {
        const latLng = e.latLng;
        const found = findClosestFix(this.tracks, latLng.lat(), latLng.lng());
        if (found != null) {
          store.dispatch(setTimestamp(found.timestamp));
          store.dispatch(setCurrentTrackId(found.track.id));
        }
      });

      this.subscriptions.push(
        msg.centerMap.subscribe(({ lat, lon }) => this.center(lat, lon)),
        msg.centerZoomMap.subscribe(({ lat, lon }, delta) => {
          this.center(lat, lon);
          this.zoom(delta);
        }),
        msg.trackGroupsAdded.subscribe(() => this.zoomToTracks()),
        msg.trackGroupsRemoved.subscribe(() => this.zoomToTracks()),
        msg.requestLocation.subscribe(() => this.updateLocation()),
        msg.geoLocation.subscribe((latLon) => this.geolocation(latLon)),
      );

      const location = store.getState().location;

      if (this.tracks.length) {
        // Zoom to tracks when there are some.
        this.zoomToTracks();
      } else {
        // Otherwise go to (priority order):
        // - location on the 3d map,
        // - gps location,
        // - initial location.
        let latLon = location.geolocation || location.start;
        let zoom = 11;
        if (location.current) {
          latLon = location.current.latLon;
          zoom = location.current.zoom;
        }
        this.map.setCenter({ lat: latLon.lat, lng: latLon.lon });
        this.map.setZoom(zoom);
      }

      store.dispatch(setApiLoading(false));
    });
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.subscriptions.forEach((sub) => sub());
    this.subscriptions.length = 0;
    this.map = undefined;
  }

  protected render(): TemplateResult {
    return html`
      <div id="map"></div>
      <topo-eu .map=${this.map}></topo-eu>
      <topo-spain .map=${this.map}></topo-spain>
      <topo-france .map=${this.map}></topo-france>
      <topo-otm .map=${this.map}></topo-otm>
      <segments-element .map=${this.map} .query=${document.location.search}></segments-element>
      ${repeat(
        this.tracks,
        (track) => track.id,
        (track) =>
          html`
            <marker-element .map=${this.map} .track=${track} .timestamp=${this.timestamp}></marker-element>
            <line-element .map=${this.map} .track=${track}></line-element>
          `,
      )}
    `;
  }

  // Center the map on the user location if they have not yet interacted with the map.
  private geolocation({ lat, lon }: LatLon): void {
    if (this.map) {
      const center = this.map.getCenter();
      const start = store.getState().location.start;
      if (center.lat() == start.lat && center.lng() == start.lon) {
        this.center(lat, lon);
      }
    }
  }

  private center(lat: number, lon: number): void {
    this.map?.setCenter({ lat, lng: lon });
  }

  private zoom(delta: number): void {
    const map = this.map;
    if (map) {
      map.setZoom(map.getZoom() + (delta < 0 ? 1 : -1));
    }
  }

  private zoomToTracks(): void {
    const extent = sel.tracksExtent(store.getState());
    if (extent != null) {
      const bounds = new google.maps.LatLngBounds(
        { lat: extent.sw.lat, lng: extent.sw.lon },
        { lat: extent.ne.lat, lng: extent.ne.lon },
      );
      this.map?.fitBounds(bounds);
    }
  }

  private updateLocation(): void {
    if (this.map) {
      const center = this.map.getCenter();
      store.dispatch(setCurrentLocation({ lat: center.lat(), lon: center.lng() }, this.map.getZoom()));
    }
  }

  createRenderRoot(): Element {
    return this;
  }
}
