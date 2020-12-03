/* eslint-disable @typescript-eslint/no-var-requires */
const spot2Feed = require('./fixtures/spot2.txt');
const spot3Feed = require('./fixtures/spot3.txt');

import { Trackers } from 'flyxc/common/src/live-track';
import { LivePoint } from 'flyxc/run/src/trackers/live-track';
import { parse } from 'flyxc/run/src/trackers/spot';

describe('Parse JSON feed', () => {
  let spot2: LivePoint[];
  let spot3: LivePoint[];

  beforeAll(() => {
    spot2 = parse(spot2Feed);
    spot3 = parse(spot3Feed);
  });
  it('should parse a spot2 Feeds', () => {
    expect(spot2).toEqual([
      {
        alt: 0,
        device: Trackers.Spot,
        emergency: false,
        lat: 44.06871,
        lon: 7.20849,
        lowBattery: false,
        message: undefined,
        timestamp: 1571231455000,
      },
      {
        alt: 0,
        device: Trackers.Spot,
        emergency: false,
        lat: 44.06923,
        lon: 7.20879,
        lowBattery: false,
        message: 'msg ok',
        timestamp: 1571230698000,
      },
      {
        alt: 0,
        device: Trackers.Spot,
        emergency: true,
        lat: 44.07498,
        lon: 7.20351,
        lowBattery: false,
        message: 'msg help',
        timestamp: 1571230128000,
      },
      {
        alt: 0,
        device: Trackers.Spot,
        emergency: false,
        lat: 44.04253,
        lon: 7.20452,
        lowBattery: true,
        message: undefined,
        timestamp: 1571229492000,
      },
      {
        alt: 0,
        device: Trackers.Spot,
        emergency: false,
        lat: 44.01246,
        lon: 7.22531,
        lowBattery: false,
        message: undefined,
        timestamp: 1571228890000,
      },
    ]);
  });

  it('should parse a spot3 feed', () => {
    expect(spot3).toEqual([
      {
        alt: 123,
        device: Trackers.Spot,
        emergency: false,
        lat: 44.06871,
        lon: 7.20849,
        lowBattery: false,
        message: undefined,
        timestamp: 1571231455000,
      },
      {
        alt: 456,
        device: Trackers.Spot,
        emergency: false,
        lat: 44.06923,
        lon: 7.20879,
        lowBattery: false,
        message: 'msg ok',
        timestamp: 1571230698000,
      },
      {
        alt: 789,
        device: Trackers.Spot,
        emergency: true,
        lat: 44.07498,
        lon: 7.20351,
        lowBattery: false,
        message: 'msg help',
        timestamp: 1571230128000,
      },
      {
        alt: 123,
        device: Trackers.Spot,
        emergency: false,
        lat: 44.04253,
        lon: 7.20452,
        lowBattery: true,
        message: undefined,
        timestamp: 1571229492000,
      },
      {
        alt: 456,
        device: Trackers.Spot,
        emergency: false,
        lat: 44.01246,
        lon: 7.22531,
        lowBattery: false,
        message: undefined,
        timestamp: 1571228890000,
      },
    ]);
  });

  it('should parse lowBattery', () => {
    expect(spot2[0].lowBattery).toBe(false);
    expect(spot2[3].lowBattery).toBe(true);
    expect(spot3[0].lowBattery).toBe(false);
    expect(spot3[3].lowBattery).toBe(true);
  });

  it('should parse emergency', () => {
    expect(spot2[0].message).toBeUndefined();
    expect(spot2[1].message).toEqual('msg ok');
    expect(spot2[2].message).toEqual('msg help');
    expect(spot3[0].message).toBeUndefined();
    expect(spot3[1].message).toEqual('msg ok');
    expect(spot3[2].message).toEqual('msg help');
  });

  it('should parse messages', () => {
    expect(spot2[0].emergency).toBe(false);
    expect(spot2[2].emergency).toBe(true);
    expect(spot3[0].emergency).toBe(false);
    expect(spot3[2].emergency).toBe(true);
  });

  it('should throw on invalid format', () => {
    expect(() => parse('random')).toThrowError('[Parse Error]: Invalid SPOT json');
  });
});
