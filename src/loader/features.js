import {Worker, workerData, parentPort} from 'worker_threads';
import along from '@turf/along';
import buffer from '@turf/buffer';
import turfDistance from '@turf/distance';
import {featureCollection, lineString, multiLineString, point} from '@turf/helpers';
import {getCoord, getCoords} from '@turf/invariant';
import turfLength from '@turf/length';
import {coordEach} from '@turf/meta';
import nearestPointOnLine from '@turf/nearest-point-on-line';
import truncate from '@turf/truncate';
import union from '@turf/union';
import destination from '../turf/destination';
import lineOffset from '../turf/line-offset';
import lineSlice from '../turf/line-slice';
import nearestPointProps from '../turf/nearest-point-props';
import * as helpers from '../helpers';
import * as loaderHelpers from './helpers';

const HIDDEN_STATIONS = /^(JR-East\.(YamanoteFreight|Musashino\w+Branch)|Keio\.Sagamihara\.Shinjuku|Keikyu\.Airport\.Shinagawa|Tobu\.THLiner|Seibu\.S-)/;

function setAltitude(geojson, altitude) {
    coordEach(geojson, coord => {
        coord[2] = altitude;
    });
}

function getLocationAlongLine(line, point) {
    const nearestPoint = nearestPointOnLine(line, point);
    return nearestPoint.properties.location;
}

function alignDirection(feature, refCoords) {
    const coords = getCoords(feature),
        start = coords[0];

    // Rewind if the line string is in opposite direction
    if (turfDistance(refCoords[0], start) > turfDistance(refCoords[refCoords.length - 1], start)) {
        coords.reverse();
    }

    return coords;
}

function interpolateCoordinates(coords, start, end) {
    const feature = lineString(coords),
        length = turfLength(feature);

    if (start) {
        const interpolatedCoords = [];
        let i;

        for (let d = 0; d <= start; d += .05) {
            interpolatedCoords.push(getCoord(along(feature, Math.min(d, length))));
            if (d >= length) {
                break;
            }
        }
        for (i = 0; i < coords.length; i++) {
            if (getLocationAlongLine(feature, coords[i]) > start) {
                break;
            }
        }
        coords.splice(0, i, ...interpolatedCoords);
    }
    if (end) {
        const interpolatedCoords = [];
        let i;

        for (let d = length; d >= length - end; d -= .05) {
            interpolatedCoords.unshift(getCoord(along(feature, Math.max(d, 0))));
            if (d <= 0) {
                break;
            }
        }
        for (i = coords.length; i > 0; i--) {
            if (getLocationAlongLine(feature, coords[i - 1]) < length - end) {
                break;
            }
        }
        coords.splice(i, coords.length - i, ...interpolatedCoords);
    }
}

function easeInOutQuad(t) {
    if ((t /= .5) < 1) {
        return .5 * t * t;
    }
    return -.5 * ((--t) * (t - 2) - 1);
}

export default async function(railwayLookup, stationLookup) {

    const [stationGroupData, coordinateData] = await Promise.all([
        'data/station-groups.json',
        'data/coordinates.json'
    ].map(loaderHelpers.loadJSON));

    const transitStations = [].concat(...stationGroupData.map(
        group => [].concat(...group)
    ));

    coordinateData.railways.forEach(({id}) =>
        ((railwayLookup[id] || {}).stations || [])
            .filter(station => !helpers.includes(transitStations, station))
            .forEach(station => stationGroupData.push([[station]]))
    );

    const featureArray = [].concat(...await Promise.all([13, 14, 15, 16, 17, 18].map(zoom =>
        new Promise(resolve => {
            const worker = new Worker(__filename, {workerData: {
                type: 'features',
                zoom,
                railways: coordinateData.railways,
                railwayLookup,
                stationLookup,
                stationGroupData
            }});

            worker.on('message', resolve);
        })
    )));

    coordinateData.airways.forEach(({id, coords, color}) => {
        const airwayFeature = lineString(coords, {
            id,
            type: 0,
            color,
            width: 8,
            altitude: 1
        });

        airwayFeature.properties.length = turfLength(airwayFeature);

        featureArray.push(airwayFeature);
    });

    loaderHelpers.saveJSON('build/data/features.json.gz', truncate(featureCollection(featureArray), {precision: 7}));

    console.log('Feature data was loaded');
}

export function featureWorker() {

    const {zoom, railways, railwayLookup, stationLookup, stationGroupData} = workerData;

    const featureLookup = {};
    const featureArray = [];

    const unit = Math.pow(2, 14 - zoom) * .1;

    railways.forEach(({id, sublines, color, altitude, loop}) => {
        let mixed = false;
        const railwayFeature = lineString([].concat(...sublines.map(subline => {
            const {type, start, end, coords, opacity} = subline,
                sublineAltitude = helpers.valueOrDefault(subline.altitude, altitude) || 0;
            let coordinates;

            function smoothCoords(nextSubline, reverse) {
                const start = !reverse ? 0 : coordinates.length - 1,
                    end = !reverse ? coordinates.length - 1 : 0,
                    step = !reverse ? 1 : -1,
                    feature = featureLookup[nextSubline.railway],
                    nearest = nearestPointProps(feature, coordinates[start]),
                    baseOffset = nextSubline.offset * unit - nearest.distance,
                    baseFeature = lineString(coordinates),
                    baseLocation = getLocationAlongLine(baseFeature, coordinates[start]),
                    transition = Math.min(Math.abs(nextSubline.offset) * .75 + .75, turfLength(baseFeature)),
                    factors = [];

                for (let i = start; i !== end; i += step) {
                    const distance = Math.abs(getLocationAlongLine(baseFeature, coordinates[i]) - baseLocation);
                    if (distance > transition) {
                        break;
                    }
                    factors[i] = easeInOutQuad(1 - distance / transition);
                }
                for (let i = start; i !== end && factors[i] > 0; i += step) {
                    coordinates[i] = getCoord(destination(
                        coordinates[i], baseOffset * factors[i], nearest.bearing
                    ));
                }
            }

            function smoothAltitude(baseAltitude, reverse) {
                const start = !reverse ? 0 : coordinates.length - 1,
                    end = !reverse ? coordinates.length - 1 : 0,
                    step = !reverse ? 1 : -1,
                    baseFeature = lineString(coordinates),
                    baseLocation = getLocationAlongLine(baseFeature, coordinates[start]),
                    baseAltitudeMeter = baseAltitude * unit * 1000;

                for (let i = start; i !== end; i += step) {
                    const distance = Math.abs(getLocationAlongLine(baseFeature, coordinates[i]) - baseLocation);
                    if (distance > .4) {
                        break;
                    }
                    coordinates[i][2] = (baseAltitudeMeter + ((coordinates[i][2] || 0) - baseAltitudeMeter) * easeInOutQuad(distance / .4));
                }
            }

            if (type === 'main' || (type === 'hybrid' && zoom >= subline.zoom)) {
                coordinates = coords.map(d => d.slice());
                if (start && start.railway && !(zoom >= start.zoom)) {
                    smoothCoords(start);
                }
                if (end && end.railway && !(zoom >= end.zoom)) {
                    smoothCoords(end, true);
                }
            } else if (type === 'sub' || (type === 'hybrid' && zoom < subline.zoom)) {
                if (start.railway === end.railway && start.offset === end.offset) {
                    const feature = lineSlice(coords[0], coords[coords.length - 1], featureLookup[start.railway]),
                        offset = start.offset;

                    coordinates = alignDirection(offset ? lineOffset(feature, offset * unit) : feature, coords);
                } else {
                    const {interpolate} = subline;
                    let feature1 = lineSlice(coords[0], coords[coords.length - 1], featureLookup[start.railway]),
                        offset = start.offset;
                    if (offset) {
                        feature1 = lineOffset(feature1, offset * unit);
                    }
                    alignDirection(feature1, coords);
                    let feature2 = lineSlice(coords[0], coords[coords.length - 1], featureLookup[end.railway]);
                    offset = end.offset;
                    if (offset) {
                        feature2 = lineOffset(feature2, offset * unit);
                    }
                    alignDirection(feature2, coords);
                    const length1 = turfLength(feature1),
                        length2 = turfLength(feature2);
                    coordinates = [];
                    for (let i = 1; i < interpolate; i++) {
                        const coord1 = getCoord(along(feature1, length1 * i / interpolate)),
                            coord2 = getCoord(along(feature2, length2 * i / interpolate)),
                            f = easeInOutQuad(i / interpolate);

                        coordinates.push([
                            coord1[0] * (1 - f) + coord2[0] * f,
                            coord1[1] * (1 - f) + coord2[1] * f
                        ]);
                    }
                }
            }
            interpolateCoordinates(coordinates,
                start && start.altitude !== undefined ? .4 : 0,
                end && end.altitude !== undefined ? .4 : 0);
            if (sublineAltitude) {
                coordinates.forEach(coord => {
                    coord[2] = sublineAltitude * unit * 1000;
                });
            }
            if (start && start.altitude !== undefined) {
                smoothAltitude(start.altitude);
                mixed = true;
            }
            if (end && end.altitude !== undefined) {
                smoothAltitude(end.altitude, true);
                mixed = true;
            }
            if (opacity !== undefined) {
                coordinates.forEach(coord => {
                    coord[3] = opacity;
                });
                mixed = true;
            }

            return coordinates;
        })), {
            id: `${id}.${zoom}`,
            type: 0,
            color,
            width: 8,
            zoom
        });

        featureLookup[id] = railwayFeature;
        if (id.startsWith('Base.')) {
            return;
        }

        railwayFeature.properties.altitude = mixed ? undefined : (altitude || 0) * unit * 1000;

        // Set station offsets
        railwayFeature.properties['station-offsets'] = railwayLookup[id].stations.map((station, i, stations) =>
            // If the line has a loop, the last offset must be set explicitly
            // Otherwise, the location of the last station goes wrong
            loop && i === stations.length - 1 ?
                turfLength(railwayFeature) :
                getLocationAlongLine(railwayFeature, stationLookup[station].coord)
        );

        featureArray.unshift(railwayFeature);

        if (mixed) {
            const ugCoords = [[]],
                ogCoords = [[]];

            getCoords(railwayFeature).forEach((coord, i, coords) => {
                if (coord[3] !== undefined) {
                    coord.pop();
                } else {
                    if (coord[2] < 0 || (coords[i - 1] && coords[i - 1][2] < 0) || (coords[i + 1] && coords[i + 1][2] < 0)) {
                        ugCoords[ugCoords.length - 1].push(coord);
                        if (!(coord[2] < 0) && (coords[i - 1] && coords[i - 1][2] < 0)) {
                            ugCoords.push([]);
                        }
                    }
                    if (!(coord[2] < 0)) {
                        ogCoords[ogCoords.length - 1].push(coord);
                        if (coords[i + 1] && coords[i + 1][2] < 0) {
                            ogCoords.push([]);
                        }
                    }
                }
            });
            if (ugCoords[ugCoords.length - 1].length === 0) {
                ugCoords.pop();
            }
            if (ogCoords[ogCoords.length - 1].length === 0) {
                ogCoords.pop();
            }
            featureArray.unshift(multiLineString(ugCoords, {
                id: `${id}.ug.${zoom}`,
                type: 0,
                color,
                width: 8,
                zoom,
                altitude: -unit * 1000
            }));
            featureArray.unshift(multiLineString(ogCoords, {
                id: `${id}.og.${zoom}`,
                type: 0,
                color,
                width: 8,
                zoom,
                altitude: 0
            }));
        }
    });

    stationGroupData.forEach(group => {
        const ug = {features: [], connectionCoords: []},
            og = {features: [], connectionCoords: []},
            ids = [];

        group.forEach(stations => {
            const {altitude} = stationLookup[stations[0]] || 0,
                layer = altitude < 0 ? ug : og,
                coords = stations.map(id => {
                    const {railway, coord} = stationLookup[id],
                        feature = featureLookup[railway];

                    if (!id.match(HIDDEN_STATIONS)) {
                        ids.push(id);
                    }
                    return getCoord(nearestPointOnLine(feature, coord));
                }),
                feature = coords.length === 1 ? point(coords[0]) : lineString(coords);

            layer.features.push(buffer(feature, unit));
            layer.connectionCoords.push(...coords);
            layer.altitude = altitude;
        });

        if (ug.features.length) {
            // If there are connections, add extra features
            if (ug.connectionCoords.length > 1) {
                ug.features.push(buffer(lineString(ug.connectionCoords), unit / 4));
            }

            const feature = union(...ug.features);

            setAltitude(feature, ug.altitude * unit * 1000);
            feature.properties = {
                type: 1,
                outlineColor: '#000000',
                width: 4,
                color: '#FFFFFF',
                zoom,
                altitude: ug.altitude * unit * 1000,
                ids
            };
            featureArray.push(feature);
        }
        if (og.features.length) {
            // If there are connections, add extra features
            if (og.connectionCoords.length > 1) {
                og.features.push(buffer(lineString(og.connectionCoords), unit / 4));
            }

            const feature = union(...og.features);

            feature.properties = {
                type: 1,
                outlineColor: '#000000',
                width: 4,
                color: '#FFFFFF',
                zoom,
                altitude: 0,
                ids
            };
            featureArray.push(feature);
        }
    });

    parentPort.postMessage(featureArray);

}
