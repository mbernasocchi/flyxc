import type Graphic from 'esri/Graphic';
import type GraphicsLayer from 'esri/layers/GraphicsLayer';
import { findIndexes } from 'flyxc/common/src/math';
import { LatLonZ, RuntimeTrack } from 'flyxc/common/src/runtime-track';
import { customElement, internalProperty, LitElement, property, PropertyValues } from 'lit-element';
import { connect } from 'pwa-helpers';

import { Api } from '../../logic/arcgis';
import * as sel from '../../redux/selectors';
import { RootState, store } from '../../redux/store';

const INACTIVE_ALPHA = 0.7;

@customElement('line3d-element')
export class Line3dElement extends connect(store)(LitElement) {
  @property({ attribute: false })
  track?: RuntimeTrack;
  @property({ attribute: false })
  api?: Api;
  @property({ attribute: false })
  layer?: GraphicsLayer;
  @property({ attribute: false })
  gndLayer?: GraphicsLayer;

  @internalProperty()
  private opacity = 1;
  @internalProperty()
  private timestamp = 0;
  @internalProperty()
  private multiplier = 0;
  @internalProperty()
  private tsOffset = 0;
  @internalProperty()
  private color = '';

  private line = {
    type: 'polyline',
    paths: [] as number[][][],
    hasZ: true,
  };

  private symbol = {
    type: 'line-3d',
    symbolLayers: [
      {
        type: 'line',
        size: 2,
        material: { color: [50, 50, 50, 0.6] },
        cap: 'round',
        join: 'round',
      },
    ],
  };

  private graphic?: Graphic;
  private gndGraphic?: Graphic;
  private path3d: number[][] = [];

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.destroyLines();
  }

  stateChanged(state: RootState): void {
    if (this.track) {
      const id = this.track.id;
      this.tsOffset = sel.tsOffsets(state)[id];
      this.color = sel.trackColors(state)[id];
      this.opacity = id == sel.currentTrackId(state) ? 1 : INACTIVE_ALPHA;
    }
    this.timestamp = state.app.timestamp;
    this.multiplier = state.app.altMultiplier;
  }

  shouldUpdate(changedProps: PropertyValues): boolean {
    if (this.api == null || this.layer == null || this.gndLayer == null) {
      this.destroyLines();
      return false;
    }

    if (changedProps.has('api') || changedProps.has('track') || changedProps.has('multiplier')) {
      this.destroyLines();
      this.maybeCreateLines();
    }

    if (this.graphic && this.track) {
      const times = this.track.ts;

      const timestamp = this.timestamp + this.tsOffset;

      const start = Math.min(findIndexes(times, timestamp - 15 * 60 * 1000).beforeIndex, times.length - 4);
      const end = Math.max(findIndexes(times, timestamp).beforeIndex + 1, 4);
      const path = this.path3d.slice(start, end);
      // The last point must match the marker position and needs to be interpolated.
      const pos = sel.getTrackLatLonAlt(store.getState())(timestamp, this.track) as LatLonZ;
      path.push([pos.lon, pos.lat, this.multiplier * pos.alt]);
      this.line.paths[0] = path;

      this.graphic.set('geometry', this.line);
      this.graphic.set('attributes', { trackId: this.track.id });
      this.gndGraphic?.set('geometry', this.line);
      this.gndGraphic?.set('attributes', { trackId: this.track.id });

      const color = new this.api.Color(this.color);
      color.a = this.opacity;
      const rgba = color.toRgba();
      this.symbol.symbolLayers[0].material.color = rgba;
      this.graphic.set('symbol', this.symbol);
    }

    return false;
  }

  private maybeCreateLines(): void {
    if (this.api && this.layer && this.gndLayer && this.track) {
      this.graphic = new this.api.Graphic();
      this.layer.add(this.graphic);
      this.symbol.symbolLayers[0].material.color = [50, 50, 50, 0.6];
      this.gndGraphic = new this.api.Graphic({ symbol: this.symbol as any });
      this.gndLayer.add(this.gndGraphic);
      this.path3d.length = 0;
      const track = this.track;
      this.track.lat.forEach((lat, i) => this.path3d.push([track.lon[i], lat, this.multiplier * track.alt[i]]));
    }
  }

  private destroyLines(): void {
    if (this.graphic) {
      this.layer?.remove(this.graphic);
    }
    this.graphic = undefined;
    if (this.gndGraphic) {
      this.gndLayer?.remove(this.gndGraphic);
    }
    this.gndGraphic = undefined;
    this.path3d.length = 0;
  }

  // There is not content - no need to create a shadow root.
  createRenderRoot(): Element {
    return this;
  }
}
