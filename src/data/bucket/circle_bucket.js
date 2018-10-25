// @flow

import { CircleLayoutArray } from '../array_types';

import { members as layoutAttributes } from './circle_attributes';
import SegmentVector from '../segment';
import { ProgramConfigurationSet } from '../program_configuration';
import { TriangleIndexArray } from '../index_array_type';
import loadGeometry from '../load_geometry';
import EXTENT from '../extent';
import { register } from '../../util/web_worker_transfer';
import EvaluationParameters from '../../style/evaluation_parameters';

import type {
    Bucket,
    BucketParameters,
    IndexedFeature,
    PopulateParameters
} from '../bucket';
import type CircleStyleLayer from '../../style/style_layer/circle_style_layer';
import type HeatmapStyleLayer from '../../style/style_layer/heatmap_style_layer';
import type Context from '../../gl/context';
import type IndexBuffer from '../../gl/index_buffer';
import type VertexBuffer from '../../gl/vertex_buffer';
import type Point from '@mapbox/point-geometry';
import type {FeatureStates} from '../../source/source_state';
import type {ImagePosition} from '../../render/image_atlas';


function addCircleVertex(layoutVertexArray, globalPosition, extrudeX, extrudeY) {
    layoutVertexArray.emplaceBack(
        globalPosition[0], // x high bits
        globalPosition[1], // y high bits
        (globalPosition[2] * 2) + ((extrudeX + 1) / 2),  // x low bits + x extrude
        (globalPosition[3] * 2) + ((extrudeY + 1) / 2)); // y low bits + y extrude
}

const maxUint15 = Math.pow(2, 15);

function globalPosition(tileX: number, tileY: number, canonical: CanonicalTileID): Array<number> {
    // Convert to a global representation:
    // xHigh (UINT16): coordinate of z16 tile containing this point
    // yHigh (UINT16): coordinate of z16 tile containing this point
    // xLow (UINT15): 15 bits of x precision within the z16 tile
    // yLow (UINT15): 15 bits of y precision within the z16 tile
    console.log(canonical);
    console.log(tileX);
    console.log(tileY);
    const scaleDiff = Math.pow(2, 16 - canonical.z);
    const tileXFractional = tileX / EXTENT;
    const tileYFractional = tileY / EXTENT;
    const fullPrecisionX = scaleDiff * canonical.x + tileXFractional * scaleDiff;
    const fullPrecisionY = scaleDiff * canonical.y + tileYFractional * scaleDiff;
    return [
        Math.floor(fullPrecisionX),
        Math.floor(fullPrecisionY),
        Math.floor((fullPrecisionX % 1) * maxUint15),
        Math.floor((fullPrecisionY % 1) * maxUint15)
    ];
}


/**
 * Circles are represented by two triangles.
 *
 * Each corner has a pos that is the center of the circle and an extrusion
 * vector that is where it points.
 * @private
 */
class CircleBucket<Layer: CircleStyleLayer | HeatmapStyleLayer> implements Bucket {
    index: number;
    zoom: number;
    overscaling: number;
    layerIds: Array<string>;
    layers: Array<Layer>;
    stateDependentLayers: Array<Layer>;

    layoutVertexArray: CircleLayoutArray;
    layoutVertexBuffer: VertexBuffer;

    indexArray: TriangleIndexArray;
    indexBuffer: IndexBuffer;

    hasPattern: boolean;
    programConfigurations: ProgramConfigurationSet<Layer>;
    segments: SegmentVector;
    uploaded: boolean;
    tileID: OverscaledTileID;

    constructor(options: BucketParameters<Layer>) {
        this.zoom = options.zoom;
        this.overscaling = options.overscaling;
        this.layers = options.layers;
        this.layerIds = this.layers.map(layer => layer.id);
        this.index = options.index;
        this.hasPattern = false;
        this.tileID = options.tileID;

        this.layoutVertexArray = new CircleLayoutArray();
        this.indexArray = new TriangleIndexArray();
        this.segments = new SegmentVector();
        this.programConfigurations = new ProgramConfigurationSet(layoutAttributes, options.layers, options.zoom);
    }

    populate(features: Array<IndexedFeature>, options: PopulateParameters) {
        for (const {feature, index, sourceLayerIndex} of features) {
            if (this.layers[0]._featureFilter(new EvaluationParameters(this.zoom), feature)) {
                const geometry = loadGeometry(feature);
                this.addFeature(feature, geometry, index);
                options.featureIndex.insert(feature, geometry, index, sourceLayerIndex, this.index);
            }
        }
    }

    update(states: FeatureStates, vtLayer: VectorTileLayer, imagePositions: {[string]: ImagePosition}) {
        if (!this.stateDependentLayers.length) return;
        this.programConfigurations.updatePaintArrays(states, vtLayer, this.stateDependentLayers, imagePositions);
    }

    isEmpty() {
        return this.layoutVertexArray.length === 0;
    }

    uploadPending() {
        return !this.uploaded || this.programConfigurations.needsUpload;
    }

    upload(context: Context) {
        if (!this.uploaded) {
            this.layoutVertexBuffer = context.createVertexBuffer(this.layoutVertexArray, layoutAttributes);
            this.indexBuffer = context.createIndexBuffer(this.indexArray);
        }
        this.programConfigurations.upload(context);
        this.uploaded = true;
    }

    destroy() {
        if (!this.layoutVertexBuffer) return;
        this.layoutVertexBuffer.destroy();
        this.indexBuffer.destroy();
        this.programConfigurations.destroy();
        this.segments.destroy();
    }

    addFeature(feature: VectorTileFeature, geometry: Array<Array<Point>>, index: number) {
        for (const ring of geometry) {
            for (const point of ring) {
                const x = point.x;
                const y = point.y;

                // Do not include points that are outside the tile boundaries.
                if (x < 0 || x >= EXTENT || y < 0 || y >= EXTENT) continue;

                // this geometry will be of the Point type, and we'll derive
                // two triangles from it.
                //
                // ┌─────────┐
                // │ 3     2 │
                // │         │
                // │ 0     1 │
                // └─────────┘

                const segment = this.segments.prepareSegment(4, this.layoutVertexArray, this.indexArray);
                const index = segment.vertexLength;

                const globalPos = globalPosition(x, y, this.tileID.canonical);

                addCircleVertex(this.layoutVertexArray, globalPos, -1, -1);
                addCircleVertex(this.layoutVertexArray, globalPos, 1, -1);
                addCircleVertex(this.layoutVertexArray, globalPos, 1, 1);
                addCircleVertex(this.layoutVertexArray, globalPos, -1, 1);

                this.indexArray.emplaceBack(index, index + 1, index + 2);
                this.indexArray.emplaceBack(index, index + 3, index + 2);

                segment.vertexLength += 4;
                segment.primitiveLength += 2;
            }
        }

        this.programConfigurations.populatePaintArrays(this.layoutVertexArray.length, feature, index, {});
    }
}

register('CircleBucket', CircleBucket, {omit: ['layers']});

export default CircleBucket;
