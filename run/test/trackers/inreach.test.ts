/* eslint-disable @typescript-eslint/no-var-requires */
const feed = require('./fixtures/inreach-feed.kml');

import { Trackers } from 'flyxc/common/src/live-track';
import { parse } from 'flyxc/run/src/trackers/inreach';

describe('Parse kml feed', () => {
  it('Should parse a valid feed', () => {
    const points = parse(feed);
    expect(points).toEqual([
      {
        device: Trackers.Inreach,
        alt: 8,
        emergency: false,
        lat: 37.385005,
        lon: -122.027765,
        message: 'Starting my trip. Follow me on where.vicb.fr',
        speed: 0,
        timestamp: 1571510460000,
        valid: true,
      },
      {
        device: Trackers.Inreach,
        alt: 8,
        emergency: true,
        lat: 37.385015,
        lon: -122.027785,
        message: undefined,
        speed: 0,
        timestamp: 1571510490000,
        valid: true,
      },
      {
        device: Trackers.Inreach,
        alt: 19,
        emergency: false,
        lat: 37.384993,
        lon: -122.027721,
        message: undefined,
        speed: 6,
        timestamp: 1571511090000,
        valid: false,
      },
      {
        device: Trackers.Inreach,
        alt: 10,
        emergency: false,
        lat: 37.385058,
        lon: -122.027765,
        message: undefined,
        speed: 0,
        timestamp: 1571511405000,
        valid: true,
      },
    ]);
  });

  it('should parse the coordinates', () => {
    expect(parse(feed)[0]).toMatchObject({
      alt: 8,
      lat: 37.385005,
      lon: -122.027765,
    });
  });

  it('should parse the timestamp', () => {
    expect(parse(feed)[0]).toMatchObject({
      timestamp: 1571510460000,
    });
  });

  it('should parse messages', () => {
    expect(parse(feed)[0]).toMatchObject({
      message: 'Starting my trip. Follow me on where.vicb.fr',
    });
  });

  it('should report emergency', () => {
    expect(parse(feed)[0].emergency).toBe(false);
    expect(parse(feed)[1].emergency).toBe(true);
  });

  it('should report invalid fix', () => {
    expect(parse(feed)[0].valid).toBe(true);
    expect(parse(feed)[2].valid).toBe(false);
  });

  it('Should parse an empty feed', () => {
    expect(parse('')).toEqual([]);
  });

  it('should throw on invalid feed', () => {
    expect(() => parse('<')).toThrowError('[Parse Error]: Invalid InReach feed');
  });
});
