import {Zcl} from 'zigbee-herdsman';
import tz from '../converters/toZigbee';
import fz from '../converters/fromZigbee';
import {Fz, Tz, ModernExtend, Range, Zh, Logger, DefinitionOta, OnEvent, Access} from './types';
import {zigbeeOTA} from '../lib/ota';
import * as globalStore from '../lib/store';
import {presets as e, access as ea, options as opt} from './exposes';
import {KeyValue, Configure, Expose, DefinitionMeta, KeyValueAny} from './types';
import {configure as lightConfigure} from './light';
import {
    getFromLookupByValue, isString, isNumber, isObject, isEndpoint,
    getFromLookup, getEndpointName, assertNumber, postfixWithEndpointName,
    noOccupancySince, precisionRound, batteryVoltageToPercentage, getOptions,
} from './utils';

function getEndpointsWithInputCluster(device: Zh.Device, cluster: string | number) {
    if (!device.endpoints) {
        throw new Error(device.ieeeAddr + ' ' + device.endpoints);
    }
    const endpoints = device.endpoints.filter((ep) => ep.getInputClusters().find((c) => isNumber(cluster) ? c.ID === cluster : c.name === cluster));
    if (endpoints.length === 0) {
        throw new Error(`Device ${device.ieeeAddr} has no input cluster ${cluster}`);
    }
    return endpoints;
}

const timeLookup = {
    'MAX': 65000,
    '1_HOUR': 3600,
    '30_MINUTES': 1800,
    '1_MINUTE': 60,
    '10_SECONDS': 10,
    'MIN': 0,
};

type ReportingConfigTime = number | keyof typeof timeLookup;
type ReportingConfigAttribute = string | number | {ID: number, type: number};
type ReportingConfig = {min: ReportingConfigTime, max: ReportingConfigTime, change: number | [number, number], attribute: ReportingConfigAttribute}
export type ReportingConfigWithoutAttribute = Omit<ReportingConfig, 'attribute'>;

function convertReportingConfigTime(time: ReportingConfigTime): number {
    if (isString(time)) {
        if (!(time in timeLookup)) throw new Error(`Reporting time '${time}' is unknown`);
        return timeLookup[time];
    } else {
        return time;
    }
}

async function setupAttributes(
    entity: Zh.Device | Zh.Endpoint, coordinatorEndpoint: Zh.Endpoint, cluster: string | number, config: ReportingConfig[], logger: Logger,
    configureReporting: boolean=true, read: boolean=true,
) {
    const endpoints = isEndpoint(entity) ? [entity] : getEndpointsWithInputCluster(entity, cluster);
    const ieeeAddr = isEndpoint(entity) ? entity.deviceIeeeAddress : entity.ieeeAddr;
    for (const endpoint of endpoints) {
        logger.debug(`Configure reporting: ${configureReporting}, read: ${read} for ${ieeeAddr}/${endpoint.ID} ${cluster} ${JSON.stringify(config)}`);
        if (configureReporting) {
            await endpoint.bind(cluster, coordinatorEndpoint);
            await endpoint.configureReporting(cluster, config.map((a) => ({
                minimumReportInterval: convertReportingConfigTime(a.min),
                maximumReportInterval: convertReportingConfigTime(a.max),
                reportableChange: a.change,
                attribute: a.attribute,
            })));
        }
        if (read) {
            try {
                // Don't fail configuration if reading this attribute fails
                // https://github.com/Koenkk/zigbee-herdsman-converters/pull/7074
                await endpoint.read(cluster, config.map((a) => isString(a) ? a : (isObject(a.attribute) ? a.attribute.ID : a.attribute)));
            } catch (e) {
                logger.debug(`Reading attribute failed: ${e}`);
            }
        }
    }
}

export function setupConfigureForReporting(
    cluster: string | number, attribute: ReportingConfigAttribute, config: ReportingConfigWithoutAttribute, access: Access,
    endpointNames?: string[],
) {
    const configureReporting = !!config;
    const read = !!(access & ea.GET);
    if (configureReporting || read) {
        const configure: Configure = async (device, coordinatorEndpoint, logger) => {
            const reportConfig = config ? {...config, attribute: attribute} : {attribute, min: -1, max: -1, change: -1};
            let entities: (Zh.Device | Zh.Endpoint)[] = [device];
            if (endpointNames) {
                const endpointsMap = new Map<string, boolean>(endpointNames.map((e) => [e, true]));
                entities = device.endpoints.filter((e) => endpointsMap.has(e.ID.toString()));
            }

            for (const entity of entities) {
                await setupAttributes(entity, coordinatorEndpoint, cluster, [reportConfig], logger, configureReporting, read);
            }
        };
        return configure;
    } else {
        return undefined;
    }
}

export function identify(): ModernExtend {
    return {
        toZigbee: [tz.identify],
        exposes: [e.identify()],
        isModernExtend: true,
    };
}

export interface OnOffArgs {
    powerOnBehavior?: boolean, ota?: DefinitionOta, skipDuplicateTransaction?: boolean, endpointNames?: string[],
    configureReporting?: boolean,
}
export function onOff(args?: OnOffArgs): ModernExtend {
    args = {powerOnBehavior: true, skipDuplicateTransaction: false, configureReporting: true, ...args};

    const exposes: Expose[] = args.endpointNames ? args.endpointNames.map((ep) => e.switch().withEndpoint(ep)) : [e.switch()];

    const fromZigbee: Fz.Converter[] = [(args.skipDuplicateTransaction ? fz.on_off_skip_duplicate_transaction : fz.on_off)];
    const toZigbee: Tz.Converter[] = [tz.on_off];

    if (args.powerOnBehavior) {
        exposes.push(e.power_on_behavior(['off', 'on', 'toggle', 'previous']));
        fromZigbee.push(fz.power_on_behavior);
        toZigbee.push(tz.power_on_behavior);
    }

    const result: ModernExtend = {exposes, fromZigbee, toZigbee, isModernExtend: true};
    if (args.ota) result.ota = args.ota;
    if (args.configureReporting) {
        result.configure = async (device, coordinatorEndpoint, logger) => {
            await setupAttributes(device, coordinatorEndpoint, 'genOnOff', [{attribute: 'onOff', min: 'MIN', max: 'MAX', change: 1}], logger);
            if (args.powerOnBehavior) {
                try {
                    // Don't fail configure if reading this attribute fails, some devices don't support it.
                    await setupAttributes(device, coordinatorEndpoint, 'genOnOff',
                        [{attribute: 'startUpOnOff', min: 'MIN', max: 'MAX', change: 1}], logger, false);
                } catch (e) {
                    if (e.message.includes('UNSUPPORTED_ATTRIBUTE')) {
                        logger.debug('Reading startUpOnOff failed, this features is unsupported');
                    } else {
                        throw e;
                    }
                }
            }
        };
    }
    return result;
}

type MultiplierDivisor = {multiplier?: number, divisor?: number}
export interface ElectricityMeterArgs {
    cluster?: 'both' | 'metering' | 'electrical',
    current?: false | MultiplierDivisor,
    power?: false | MultiplierDivisor,
    voltage?: false | MultiplierDivisor,
    energy?: false | MultiplierDivisor
}
export function electricityMeter(args?: ElectricityMeterArgs): ModernExtend {
    args = {cluster: 'both', ...args};
    if (args.cluster === 'metering' && isObject(args.power) && isObject(args.energy) &&
        (args.power?.divisor !== args.energy?.divisor || args.power?.multiplier !== args.energy?.multiplier)) {
        throw new Error(`When cluster is metering, power and energy divisor/multiplier should be equal`);
    }

    let exposes: Expose[];
    let fromZigbee: Fz.Converter[];
    let toZigbee: Tz.Converter[];

    const configureLookup = {
        haElectricalMeasurement: {
            // Report change with every 5W change
            power: {attribute: 'activePower', divisor: 'acPowerDivisor', multiplier: 'acPowerMultiplier', forced: args.power, change: 5},
            // Report change with every 0.05A change
            current: {attribute: 'rmsCurrent', divisor: 'acCurrentDivisor', multiplier: 'acCurrentMultiplier', forced: args.current, change: 0.05},
            // Report change with every 5V change
            voltage: {attribute: 'rmsVoltage', divisor: 'acVoltageDivisor', multiplier: 'acVoltageMultiplier', forced: args.voltage, change: 5},
        },
        seMetering: {
            // Report change with every 5W change
            power: {attribute: 'instantaneousDemand', divisor: 'divisor', multiplier: 'multiplier', forced: args.power, change: 5},
            // Report change with every 0.1kWh change
            energy: {attribute: 'currentSummDelivered', divisor: 'divisor', multiplier: 'multiplier', forced: args.energy, change: 0.1},
            // produced_energy: {attribute: 'currentSummReceived', divisor: 'divisor', multiplier: 'multiplier', forced: args.energy, change: 0.1},
        },
    };

    if (args.power === false) {
        delete configureLookup.haElectricalMeasurement.power;
        delete configureLookup.seMetering.power;
    }
    if (args.voltage === false) delete configureLookup.haElectricalMeasurement.voltage;
    if (args.current === false) delete configureLookup.haElectricalMeasurement.current;
    if (args.energy === false) delete configureLookup.seMetering.energy;

    if (args.cluster === 'both') {
        exposes = [
            e.power().withAccess(ea.STATE_GET), e.voltage().withAccess(ea.STATE_GET),
            e.current().withAccess(ea.STATE_GET), e.energy().withAccess(ea.STATE_GET),
        ];
        fromZigbee = [fz.electrical_measurement, fz.metering];
        toZigbee = [tz.electrical_measurement_power, tz.acvoltage, tz.accurrent, tz.currentsummdelivered];
        delete configureLookup.seMetering.power;
    } else if (args.cluster === 'metering') {
        exposes = [e.power().withAccess(ea.STATE_GET), e.energy().withAccess(ea.STATE_GET)];
        fromZigbee = [fz.metering];
        toZigbee = [tz.metering_power, tz.currentsummdelivered];
        delete configureLookup.haElectricalMeasurement;
    } else if (args.cluster === 'electrical') {
        exposes = [e.power().withAccess(ea.STATE_GET), e.voltage().withAccess(ea.STATE_GET), e.current().withAccess(ea.STATE_GET)];
        fromZigbee = [fz.electrical_measurement];
        toZigbee = [tz.electrical_measurement_power, tz.acvoltage, tz.accurrent];
        delete configureLookup.seMetering;
    }

    const configure: Configure = async (device, coordinatorEndpoint, logger) => {
        for (const [cluster, properties] of Object.entries(configureLookup)) {
            for (const endpoint of getEndpointsWithInputCluster(device, cluster)) {
                const items: ReportingConfig[] = [];
                for (const property of Object.values(properties)) {
                    // In case multiplier or divisor was provided, use that instead of reading from device.
                    if (property.forced) {
                        endpoint.saveClusterAttributeKeyValue(cluster, {
                            [property.divisor]: property.forced.divisor ?? 1,
                            [property.multiplier]: property.forced.multiplier ?? 1,
                        });
                        endpoint.save();
                    } else {
                        await endpoint.read(cluster, [property.divisor, property.multiplier]);
                    }

                    const divisor = endpoint.getClusterAttributeValue(cluster, property.divisor);
                    assertNumber(divisor, property.divisor);
                    const multiplier = endpoint.getClusterAttributeValue(cluster, property.multiplier);
                    assertNumber(multiplier, property.multiplier);
                    let change: number | [number, number] = property.change * (divisor / multiplier);
                    // currentSummDelivered data type is uint48, so reportableChange also is uint48
                    if (property.attribute === 'currentSummDelivered') change = [0, change];
                    items.push({attribute: property.attribute, min: '10_SECONDS', max: 'MAX', change});
                }
                if (items.length) {
                    await setupAttributes(endpoint, coordinatorEndpoint, cluster, items, logger);
                }
            }
        }
    };

    return {exposes, fromZigbee, toZigbee, configure, isModernExtend: true};
}

export interface LightArgs {
    effect?: boolean, powerOnBehavior?: boolean, colorTemp?: {startup?: boolean, range: Range},
    color?: boolean | {modes?: ('xy' | 'hs')[], applyRedFix?: boolean, enhancedHue?: boolean}, turnsOffAtBrightness1?: boolean,
    configureReporting?: boolean, endpointNames?: string[], ota?: DefinitionOta, levelConfig?: {disabledFeatures?: string[]},
}
export function light(args?: LightArgs): ModernExtend {
    args = {effect: true, powerOnBehavior: true, configureReporting: false, ...args};
    if (args.colorTemp) {
        args.colorTemp = {startup: true, ...args.colorTemp};
    }
    const argsColor = args.color ? {
        modes: ['xy'] satisfies ('xy' | 'hs')[], applyRedFix: false, enhancedHue: true, ...(isObject(args.color) ? args.color : {}),
    } : false;

    const lightExpose = args.endpointNames ?
        args.endpointNames.map((ep) => e.light().withBrightness().withEndpoint(ep)) : [e.light().withBrightness()];

    const fromZigbee: Fz.Converter[] = [fz.on_off, fz.brightness, fz.ignore_basic_report, fz.level_config];
    const toZigbee: Tz.Converter[] = [
        tz.light_onoff_brightness, tz.ignore_transition, tz.level_config, tz.ignore_rate, tz.light_brightness_move, tz.light_brightness_step,
    ];
    const meta: DefinitionMeta = {};

    if (args.colorTemp || argsColor) {
        fromZigbee.push(fz.color_colortemp);
        if (args.colorTemp && argsColor) toZigbee.push(tz.light_color_colortemp);
        else if (args.colorTemp) toZigbee.push(tz.light_colortemp);
        else if (argsColor) toZigbee.push(tz.light_color);
        toZigbee.push(tz.light_color_mode, tz.light_color_options);
    }

    if (args.colorTemp) {
        lightExpose.forEach((e) => e.withColorTemp(args.colorTemp.range));
        toZigbee.push(tz.light_colortemp_move, tz.light_colortemp_step);
        if (args.colorTemp.startup) {
            toZigbee.push(tz.light_colortemp_startup);
            lightExpose.forEach((e) => e.withColorTempStartup(args.colorTemp.range));
        }
    }

    if (argsColor) {
        lightExpose.forEach((e) => e.withColor(argsColor.modes));
        toZigbee.push(tz.light_hue_saturation_move, tz.light_hue_saturation_step);
        if (argsColor.modes.includes('hs')) {
            meta.supportsHueAndSaturation = true;
        }
        if (argsColor.applyRedFix) {
            meta.applyRedFix = true;
        }
        if (!argsColor.enhancedHue) {
            meta.supportsEnhancedHue = false;
        }
    }

    if (args.levelConfig) {
        lightExpose.forEach((e) => e.withLevelConfig(args.levelConfig.disabledFeatures ?? []));
        toZigbee.push(tz.level_config);
    }

    const exposes: Expose[] = lightExpose;

    if (args.effect) {
        exposes.push(e.effect());
        toZigbee.push(tz.effect);
    }

    if (args.powerOnBehavior) {
        exposes.push(e.power_on_behavior(['off', 'on', 'toggle', 'previous']));
        fromZigbee.push(fz.power_on_behavior);
        toZigbee.push(tz.power_on_behavior);
    }

    if (args.hasOwnProperty('turnsOffAtBrightness1')) {
        meta.turnsOffAtBrightness1 = args.turnsOffAtBrightness1;
    }

    const configure: Configure = async (device, coordinatorEndpoint, logger) => {
        await lightConfigure(device, coordinatorEndpoint, logger, true);

        if (args.configureReporting) {
            await setupAttributes(device, coordinatorEndpoint, 'genOnOff', [{attribute: 'onOff', min: 'MIN', max: 'MAX', change: 1}], logger);
            await setupAttributes(device, coordinatorEndpoint, 'genLevelCtrl',
                [{attribute: 'currentLevel', min: '10_SECONDS', max: 'MAX', change: 1}], logger);
            if (args.colorTemp) {
                await setupAttributes(device, coordinatorEndpoint, 'lightingColorCtrl',
                    [{attribute: 'colorTemperature', min: '10_SECONDS', max: 'MAX', change: 1}], logger);
            }
            if (argsColor) {
                const attributes: ReportingConfig[] = [];
                if (argsColor.modes.includes('xy')) {
                    attributes.push(
                        {attribute: 'currentX', min: '10_SECONDS', max: 'MAX', change: 1},
                        {attribute: 'currentY', min: '10_SECONDS', max: 'MAX', change: 1},
                    );
                }
                if (argsColor.modes.includes('hs')) {
                    attributes.push(
                        {attribute: argsColor.enhancedHue ? 'enhancedCurrentHue' : 'currentHue', min: '10_SECONDS', max: 'MAX', change: 1},
                        {attribute: 'currentSaturation', min: '10_SECONDS', max: 'MAX', change: 1},
                    );
                }
                await setupAttributes(device, coordinatorEndpoint, 'lightingColorCtrl', attributes, logger);
            }
        }
    };

    const result: ModernExtend = {exposes, fromZigbee, toZigbee, configure, meta, isModernExtend: true};
    if (args.ota) result.ota = args.ota;
    return result;
}

export interface LockArgs {pinCodeCount: number}
export function lock(args?: LockArgs): ModernExtend {
    args = {...args};

    const fromZigbee = [fz.lock, fz.lock_operation_event, fz.lock_programming_event, fz.lock_pin_code_response,
        fz.lock_user_status_response];
    const toZigbee = [tz.lock, tz.pincode_lock, tz.lock_userstatus, tz.lock_auto_relock_time, tz.lock_sound_volume];
    const exposes = [e.lock(), e.pincode(), e.lock_action(), e.lock_action_source_name(), e.lock_action_user(),
        e.auto_relock_time().withValueMin(0).withValueMax(3600), e.sound_volume()];
    const configure: Configure = async (device, coordinatorEndpoint, logger) => {
        await setupAttributes(device, coordinatorEndpoint, 'closuresDoorLock', [
            {attribute: 'lockState', min: 'MIN', max: '1_HOUR', change: 0}], logger);
    };
    const meta: DefinitionMeta = {pinCodeCount: args.pinCodeCount};

    return {fromZigbee, toZigbee, exposes, configure, meta, isModernExtend: true};
}

export interface EnumLookupArgs {
    name: string, lookup: KeyValue, cluster: string | number, attribute: string | {ID: number, type: number}, description: string,
    zigbeeCommandOptions?: {manufacturerCode?: number, disableDefaultResponse?: boolean}, access?: 'STATE' | 'STATE_GET' | 'ALL',
    endpointName?: string, reporting?: ReportingConfigWithoutAttribute, entityCategory?: 'config' | 'diagnostic',
}
export function enumLookup(args: EnumLookupArgs): ModernExtend {
    const {name, lookup, cluster, attribute, description, zigbeeCommandOptions, endpointName, reporting, entityCategory} = args;
    const attributeKey = isString(attribute) ? attribute : attribute.ID;
    const access = ea[args.access ?? 'ALL'];

    let expose = e.enum(name, access, Object.keys(lookup)).withDescription(description);
    if (endpointName) expose = expose.withEndpoint(endpointName);
    if (entityCategory) expose = expose.withCategory(entityCategory);

    const fromZigbee: Fz.Converter[] = [{
        cluster: cluster.toString(),
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            if (attributeKey in msg.data && (!endpointName || getEndpointName(msg, model, meta) === endpointName)) {
                return {[expose.property]: getFromLookupByValue(msg.data[attributeKey], lookup)};
            }
        },
    }];

    const toZigbee: Tz.Converter[] = [{
        key: [name],
        convertSet: access & ea.SET ? async (entity, key, value, meta) => {
            const payloadValue = getFromLookup(value, lookup);
            const payload = isString(attribute) ? {[attribute]: payloadValue} : {[attribute.ID]: {value: payloadValue, type: attribute.type}};
            await entity.write(cluster, payload, zigbeeCommandOptions);
            return {state: {[key]: value}};
        } : undefined,
        convertGet: access & ea.GET ? async (entity, key, meta) => {
            await entity.read(cluster, [attributeKey], zigbeeCommandOptions);
        } : undefined,
    }];

    const configure = setupConfigureForReporting(cluster, attribute, reporting, access);

    return {exposes: [expose], fromZigbee, toZigbee, configure, isModernExtend: true};
}

// type provides a way to distinguish between fromZigbee and toZigbee value conversions if they are asymmetrical
export type ScaleFunction = (value: number, type: 'from' | 'to') => number;

export interface NumericArgs {
    name: string, cluster: string | number, attribute: string | {ID: number, type: number}, description: string,
    zigbeeCommandOptions?: {manufacturerCode?: number, disableDefaultResponse?: boolean}, access?: 'STATE' | 'STATE_GET' | 'ALL', unit?: string,
    endpointNames?: string[], reporting?: ReportingConfigWithoutAttribute,
    valueMin?: number, valueMax?: number, valueStep?: number, scale?: number | ScaleFunction, label?: string,
    entityCategory?: 'config' | 'diagnostic', precision?: number,
}
export function numeric(args: NumericArgs): ModernExtend {
    const {
        name, cluster, attribute, description, zigbeeCommandOptions, unit, reporting, valueMin, valueMax, valueStep, scale, label,
        entityCategory, precision,
    } = args;

    const endpoints = args.endpointNames;
    const attributeKey = isString(attribute) ? attribute : attribute.ID;
    const access = ea[args.access ?? 'ALL'];

    const exposes: Expose[] = [];

    const createExpose = (endpoint?: string): Expose => {
        let expose = e.numeric(name, access).withDescription(description);
        if (endpoint) expose = expose.withEndpoint(endpoint);
        if (unit) expose = expose.withUnit(unit);
        if (valueMin !== undefined) expose = expose.withValueMin(valueMin);
        if (valueMax !== undefined) expose = expose.withValueMax(valueMax);
        if (valueStep !== undefined) expose = expose.withValueStep(valueStep);
        if (label !== undefined) expose = expose.withLabel(label);
        if (entityCategory) expose = expose.withCategory(entityCategory);

        return expose;
    };
    // Generate for multiple endpoints only if required
    const noEndpoint = !endpoints || (endpoints && endpoints.length === 1 && endpoints[0] === '1');
    if (noEndpoint) {
        exposes.push(createExpose(undefined));
    } else {
        for (const endpoint of endpoints) {
            exposes.push(createExpose(endpoint));
        }
    }

    const fromZigbee: Fz.Converter[] = [{
        cluster: cluster.toString(),
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            if (attributeKey in msg.data) {
                const endpoint = endpoints?.find((e) => getEndpointName(msg, model, meta) === e);
                if (endpoints && !endpoint) {
                    return;
                }

                let value = msg.data[attributeKey];
                assertNumber(value);
                if (scale !== undefined) {
                    value = typeof scale === 'number' ? value / scale : scale(value, 'from');
                }
                assertNumber(value);
                if (precision != null) value = precisionRound(value, precision);

                const expose = exposes.length === 1 ? exposes[0] : exposes.find((e) => e.endpoint === endpoint);
                return {[expose.property]: value};
            }
        },
    }];

    const toZigbee: Tz.Converter[] = [{
        key: [name],
        convertSet: access & ea.SET ? async (entity, key, value, meta) => {
            assertNumber(value, key);
            let payloadValue = value;
            if (scale !== undefined) {
                payloadValue = typeof scale === 'number' ? payloadValue * scale : scale(payloadValue, 'to');
            }
            assertNumber(payloadValue);
            if (precision != null) payloadValue = precisionRound(value, precision);
            const payload = isString(attribute) ? {[attribute]: payloadValue} : {[attribute.ID]: {value: payloadValue, type: attribute.type}};
            await entity.write(cluster, payload, zigbeeCommandOptions);
            return {state: {[key]: value}};
        } : undefined,
        convertGet: access & ea.GET ? async (entity, key, meta) => {
            await entity.read(cluster, [attributeKey], zigbeeCommandOptions);
        } : undefined,
    }];

    const configure = setupConfigureForReporting(cluster, attribute, reporting, access, endpoints);

    return {exposes, fromZigbee, toZigbee, configure, isModernExtend: true};
}

export interface BinaryArgs {
    name: string, valueOn: [string | boolean, unknown], valueOff: [string | boolean, unknown], cluster: string | number,
    attribute: string | {ID: number, type: number}, description: string, zigbeeCommandOptions?: {manufacturerCode: number},
    endpointName?: string, reporting?: ReportingConfig, access?: 'STATE' | 'STATE_GET' | 'ALL', entityCategory?: 'config' | 'diagnostic',
}
export function binary(args: BinaryArgs): ModernExtend {
    const {name, valueOn, valueOff, cluster, attribute, description, zigbeeCommandOptions, endpointName, reporting, entityCategory} = args;
    const attributeKey = isString(attribute) ? attribute : attribute.ID;
    const access = ea[args.access ?? 'ALL'];

    let expose = e.binary(name, access, valueOn[0], valueOff[0]).withDescription(description);
    if (endpointName) expose = expose.withEndpoint(endpointName);
    if (entityCategory) expose = expose.withCategory(entityCategory);

    const fromZigbee: Fz.Converter[] = [{
        cluster: cluster.toString(),
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            if (attributeKey in msg.data && (!endpointName || getEndpointName(msg, model, meta) === endpointName)) {
                return {[expose.property]: msg.data[attributeKey] === valueOn[1] ? valueOn[0] : valueOff[0]};
            }
        },
    }];

    const toZigbee: Tz.Converter[] = [{
        key: [name],
        convertSet: access & ea.SET ? async (entity, key, value, meta) => {
            const payloadValue = value === valueOn[0] ? valueOn[1] : valueOff[1];
            const payload = isString(attribute) ? {[attribute]: payloadValue} : {[attribute.ID]: {value: payloadValue, type: attribute.type}};
            await entity.write(cluster, payload, zigbeeCommandOptions);
            return {state: {[key]: value}};
        } : undefined,
        convertGet: access & ea.GET ? async (entity, key, meta) => {
            await entity.read(cluster, [attributeKey], zigbeeCommandOptions);
        } : undefined,
    }];

    const configure = setupConfigureForReporting(cluster, attribute, reporting, access);

    return {exposes: [expose], fromZigbee, toZigbee, configure, isModernExtend: true};
}

export interface ActionEnumLookupArgs {
    actionLookup: KeyValue, cluster: string | number, attribute: string | {ID: number, type: number}, endpointNames?: string[],
    buttonLookup?: KeyValue, extraActions?: string[], commands?: string[],
}
export function actionEnumLookup(args: ActionEnumLookupArgs): ModernExtend {
    const {actionLookup: lookup, attribute, cluster, buttonLookup} = args;
    const attributeKey = isString(attribute) ? attribute : attribute.ID;
    const commands = args.commands || ['attributeReport', 'readResponse'];

    let actions = Object.keys(lookup).map((a) => args.endpointNames ? args.endpointNames.map((e) => `${a}_${e}`) : [a]).flat();
    // allows direct external input to be used by other extends in the same device
    if (args.extraActions) actions = actions.concat(args.extraActions);
    const expose = e.enum('action', ea.STATE, actions).withDescription('Triggered action (e.g. a button click)');

    const fromZigbee: Fz.Converter[] = [{
        cluster: cluster.toString(),
        type: commands,
        convert: (model, msg, publish, options, meta) => {
            if (attributeKey in msg.data) {
                let value = getFromLookupByValue(msg.data[attributeKey], lookup);
                // endpointNames is used when action endpoint names don't overlap with other endpoint names
                if (args.endpointNames) value = postfixWithEndpointName(value, msg, model, meta);
                // buttonLookup is used when action endpoint names overlap with other endpoint names
                if (args.buttonLookup) {
                    const endpointName = getFromLookupByValue(msg.endpoint.ID, buttonLookup);
                    value =`${value}_${endpointName}`;
                }
                return {[expose.property]: value};
            }
        },
    }];

    return {exposes: [expose], fromZigbee, isModernExtend: true};
}

export function forcePowerSource(args: {powerSource: 'Mains (single phase)' | 'Battery'}): ModernExtend {
    const configure: Configure = async (device, coordinatorEndpoint, logger) => {
        device.powerSource = args.powerSource;
        device.save();
    };
    return {configure, isModernExtend: true};
}

export interface QuirkAddEndpointClusterArgs {
    endpointID: number, inputClusters?: string[] | number[], outputClusters?: string[] | number[],
}
export function quirkAddEndpointCluster(args: QuirkAddEndpointClusterArgs): ModernExtend {
    const {endpointID, inputClusters, outputClusters} = args;

    const configure: Configure = async (device, coordinatorEndpoint, logger) => {
        const endpoint = device.getEndpoint(endpointID);

        if (endpoint == undefined) {
            logger.error(`Quirk: cannot add clusters to endpoint ${endpointID}, endpoint does not exist!`);
            return;
        }

        inputClusters?.forEach((cluster: number | string) => {
            const clusterID = isString(cluster) ?
                Zcl.Utils.getCluster(cluster, device.manufacturerID).ID :
                cluster;

            if (!endpoint.inputClusters.includes(clusterID)) {
                logger.debug(`Quirk: adding input cluster ${clusterID} to endpoint ${endpointID}.`);
                endpoint.inputClusters.push(clusterID);
            }
        });

        outputClusters?.forEach((cluster: number | string) => {
            const clusterID = isString(cluster) ?
                Zcl.Utils.getCluster(cluster, device.manufacturerID).ID :
                cluster;

            if (!endpoint.outputClusters.includes(clusterID)) {
                logger.debug(`Quirk: adding output cluster ${clusterID} to endpoint ${endpointID}.`);
                endpoint.outputClusters.push(clusterID);
            }
        });

        device.save();
    };

    return {configure, isModernExtend: true};
}

export function quirkCheckinInterval(timeout: number | keyof typeof timeLookup): ModernExtend {
    const configure: Configure = async (device, coordinatorEndpoint, logger) => {
        device.checkinInterval = (typeof timeout == 'number') ? timeout : timeLookup[timeout];
        device.save();
    };

    return {configure, isModernExtend: true};
}

export function reconfigureReportingsOnDeviceAnnounce(): ModernExtend {
    const onEvent: OnEvent = async (type, data, device, options, state: KeyValue) => {
        if (type === 'deviceAnnounce') {
            for (const endpoint of device.endpoints) {
                for (const c of endpoint.configuredReportings) {
                    await endpoint.configureReporting(c.cluster.name, [{
                        attribute: c.attribute.name, minimumReportInterval: c.minimumReportInterval,
                        maximumReportInterval: c.maximumReportInterval, reportableChange: c.reportableChange,
                    }]);
                }
            }
        }
    };

    return {onEvent, isModernExtend: true};
}

export function customTimeResponse(start: '1970_UTC' | '2000_LOCAL'): ModernExtend {
    const onEvent: OnEvent = async (type, data, device, options, state: KeyValue) => {
        device.skipTimeResponse = true;
        // The Zigbee Cluster Library specification states that the genTime.time response should be the
        // number of seconds since 1st Jan 2000 00:00:00 UTC. This extend modifies that:
        // 1970_UTC: number of seconds since the Unix Epoch (1st Jan 1970 00:00:00 UTC)
        // 2000_LOCAL: seconds since 1 January in the local time zone.
        // Disable the responses of zigbee-herdsman and respond here instead.
        if (type === 'message' && data.type === 'read' && data.cluster === 'genTime') {
            const payload: KeyValue = {};
            if (start === '1970_UTC') {
                const time = Math.round(((new Date()).getTime()) / 1000);
                payload.time = time;
                payload.localTime = time - (new Date()).getTimezoneOffset() * 60;
            } else if (start === '2000_LOCAL') {
                const oneJanuary2000 = new Date('January 01, 2000 00:00:00 UTC+00:00').getTime();
                const secondsUTC = Math.round(((new Date()).getTime() - oneJanuary2000) / 1000);
                payload.time = secondsUTC - (new Date()).getTimezoneOffset() * 60;
            }
            data.endpoint.readResponse('genTime', data.meta.zclTransactionSequenceNumber, payload);
        }
    };

    return {onEvent, isModernExtend: true};
}

export function forceDeviceType(args: {type: 'EndDevice' | 'Router'}): ModernExtend {
    const configure: Configure = async (device, coordinatorEndpoint, logger) => {
        device.type = args.type;
        device.save();
    };
    return {configure, isModernExtend: true};
}

export function deviceEndpoints(args: {endpoints: {[n: string]: number}, multiEndpointSkip?: string[]}): ModernExtend {
    const result: ModernExtend = {
        meta: {multiEndpoint: true},
        endpoint: (d) => args.endpoints,
        isModernExtend: true,
    };

    if (args.multiEndpointSkip) result.meta.multiEndpointSkip = args.multiEndpointSkip;

    return result;
}

export function ota(definition?: DefinitionOta): ModernExtend {
    return {ota: definition !== undefined ? definition : zigbeeOTA, isModernExtend: true};
}

export function temperature(args?: Partial<NumericArgs>) {
    return numeric({
        name: 'temperature',
        cluster: 'msTemperatureMeasurement',
        attribute: 'measuredValue',
        reporting: {min: '10_SECONDS', max: '1_HOUR', change: 100},
        description: 'Measured temperature value',
        unit: '°C',
        scale: 100,
        access: 'STATE_GET',
        ...args,
    });
}

export function humidity(args?: Partial<NumericArgs>) {
    return numeric({
        name: 'humidity',
        cluster: 'msRelativeHumidity',
        attribute: 'measuredValue',
        reporting: {min: '10_SECONDS', max: '1_HOUR', change: 100},
        description: 'Measured relative humidity',
        unit: '%',
        scale: 100,
        access: 'STATE_GET',
        ...args,
    });
}

export function co2(args?: Partial<NumericArgs>) {
    return numeric({
        name: 'co2',
        cluster: 'msCO2',
        label: 'CO2',
        attribute: 'measuredValue',
        reporting: {min: '10_SECONDS', max: '1_HOUR', change: 0.00005}, // 50 ppm change
        description: 'Measured value',
        unit: 'ppm',
        scale: 0.000001,
        access: 'STATE_GET',
        ...args,
    });
}

export interface BatteryArgs {
    voltageToPercentage?: string | {min: number, max: number}, dontDividePercentage?: boolean,
    percentage?: boolean, voltage?: boolean, lowStatus?: boolean,
    percentageReportingConfig?: ReportingConfigWithoutAttribute, percentageReporting?: boolean,
    voltageReportingConfig?: ReportingConfigWithoutAttribute, voltageReporting?: boolean,
}
export function battery(args?: BatteryArgs): ModernExtend {
    args = {percentage: true, voltage: false, lowStatus: false, percentageReporting: true, voltageReporting: false, ...args};
    const meta: DefinitionMeta = {battery: {}};
    if (args.voltageToPercentage) meta.battery.voltageToPercentage = args.voltageToPercentage;
    if (args.dontDividePercentage) meta.battery.dontDividePercentage = args.dontDividePercentage;

    const exposes: Expose[] = [];

    if (args.percentage) {
        exposes.push(
            e.numeric('battery', ea.STATE).withUnit('%')
                .withDescription('Remaining battery in %')
                .withValueMin(0).withValueMax(100).withCategory('diagnostic'),
        );
    }
    if (args.voltage) {
        exposes.push(
            e.numeric('voltage', ea.STATE).withUnit('mV')
                .withDescription('Reported battery voltage in millivolts').withCategory('diagnostic'),
        );
    }
    if (args.lowStatus) {
        exposes.push(
            e.binary('battery_low', ea.STATE, true, false)
                .withDescription('Empty battery indicator').withCategory('diagnostic'),
        );
    }

    const fromZigbee: Fz.Converter[] = [{
        cluster: 'genPowerCfg',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const payload: KeyValueAny = {};
            if (msg.data.hasOwnProperty('batteryPercentageRemaining') && (msg.data['batteryPercentageRemaining'] < 255)) {
                // Some devices do not comply to the ZCL and report a
                // batteryPercentageRemaining of 100 when the battery is full (should be 200).
                const dontDividePercentage = model.meta && model.meta.battery && model.meta.battery.dontDividePercentage;
                let percentage = msg.data['batteryPercentageRemaining'];
                percentage = dontDividePercentage ? percentage : percentage / 2;
                if (args.percentage) payload.battery = precisionRound(percentage, 2);
            }

            if (msg.data.hasOwnProperty('batteryVoltage') && (msg.data['batteryVoltage'] < 255)) {
                // Deprecated: voltage is = mV now but should be V
                if (args.voltage) payload.voltage = msg.data['batteryVoltage'] * 100;

                if (model.meta && model.meta.battery && model.meta.battery.voltageToPercentage) {
                    payload.battery = batteryVoltageToPercentage(payload.voltage, model.meta.battery.voltageToPercentage);
                }
            }

            if (msg.data.hasOwnProperty('batteryAlarmState')) {
                const battery1Low = (
                    msg.data.batteryAlarmState & 1<<0 ||
                    msg.data.batteryAlarmState & 1<<1 ||
                    msg.data.batteryAlarmState & 1<<2 ||
                    msg.data.batteryAlarmState & 1<<3
                ) > 0;
                const battery2Low = (
                    msg.data.batteryAlarmState & 1<<10 ||
                    msg.data.batteryAlarmState & 1<<11 ||
                    msg.data.batteryAlarmState & 1<<12 ||
                    msg.data.batteryAlarmState & 1<<13
                ) > 0;
                const battery3Low = (
                    msg.data.batteryAlarmState & 1<<20 ||
                    msg.data.batteryAlarmState & 1<<21 ||
                    msg.data.batteryAlarmState & 1<<22 ||
                    msg.data.batteryAlarmState & 1<<23
                ) > 0;
                if (args.lowStatus) payload.battery_low = battery1Low || battery2Low || battery3Low;
            }

            return payload;
        },
    }];

    const defaultReporting: ReportingConfigWithoutAttribute = {min: '1_HOUR', max: 'MAX', change: 10};

    const configure: Configure = async (device, coordinatorEndpoint, logger) => {
        if (args.percentageReporting) {
            await setupAttributes(device, coordinatorEndpoint, 'genPowerCfg', [
                {attribute: 'batteryPercentageRemaining', ...(args.percentageReportingConfig ?? defaultReporting)},
            ], logger);
        }
        if (args.voltageReporting) {
            await setupAttributes(device, coordinatorEndpoint, 'genPowerCfg', [
                {attribute: 'batteryVoltage', ...(args.voltageReportingConfig ?? defaultReporting)},
            ], logger);
        }
    };

    return {meta, fromZigbee, exposes, configure, isModernExtend: true};
}

export function pressure(args?: Partial<NumericArgs>): ModernExtend {
    return numeric({
        name: 'pressure',
        cluster: 'msPressureMeasurement',
        attribute: 'measuredValue',
        reporting: {min: '10_SECONDS', max: '1_HOUR', change: 50}, // 5 kPa
        description: 'The measured atmospheric pressure',
        unit: 'kPa',
        scale: 10,
        access: 'STATE_GET',
        ...args,
    });
}

export function illuminance(args?: Partial<NumericArgs>): ModernExtend {
    const luxScale: ScaleFunction = (value: number, type: 'from' | 'to') => {
        let result = value;
        if (type === 'from') {
            result = Math.pow(10, (result - 1) / 10000);
        }
        return result;
    };

    const rawIllinance = numeric({
        name: 'illuminance',
        cluster: 'msIlluminanceMeasurement',
        attribute: 'measuredValue',
        description: 'Raw measured illuminance',
        access: 'STATE_GET',
        ...args,
    });

    const illiminanceLux = numeric({
        name: 'illuminance_lux',
        cluster: 'msIlluminanceMeasurement',
        attribute: 'measuredValue',
        reporting: {min: '10_SECONDS', max: '1_HOUR', change: 5}, // 5 lux
        description: 'Measured illuminance in lux',
        unit: 'lx',
        scale: luxScale,
        access: 'STATE_GET',
        ...args,
    });

    const result: ModernExtend = illiminanceLux;
    result.fromZigbee.push(...rawIllinance.fromZigbee);
    result.toZigbee.push(...rawIllinance.toZigbee);
    result.exposes.push(...rawIllinance.exposes);

    return result;
}

export function occupancy(args?: Partial<BinaryArgs>): ModernExtend {
    const name = 'occupancy';
    const cluster = 'msOccupancySensing';
    const attribute = 'occupancy';
    const valueOn: [string | boolean, unknown] = [true, true];
    const valueOff: [string | boolean, unknown] = [false, false];

    const result = binary({
        name: name,
        cluster: cluster,
        attribute: attribute,
        reporting: {attribute: attribute, min: '10_SECONDS', max: '1_MINUTE', change: 0},
        description: 'Indicates whether the device detected occupancy',
        access: 'STATE_GET',
        valueOn: valueOn,
        valueOff: valueOff,
        ...args,
    });

    const fromZigbeeOverride: Fz.Converter = {
        cluster: cluster.toString(),
        type: ['attributeReport', 'readResponse'],
        options: [opt.no_occupancy_since_false()],
        convert: (model, msg, publish, options, meta) => {
            if (attribute in msg.data && (!args?.endpointName || getEndpointName(msg, model, meta) === args?.endpointName)) {
                const payload = {[name]: (msg.data[attribute] % 2) > 0};
                noOccupancySince(msg.endpoint, options, publish, payload.occupancy ? 'stop' : 'start');
                return payload;
            }
        },
    };

    result.fromZigbee[0] = fromZigbeeOverride;

    return result;
}

export function ignoreClusterReport(args: {cluster: string | number}): ModernExtend {
    const fromZigbee: Fz.Converter[] = [{
        cluster: args.cluster.toString(),
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {},
    }];

    return {fromZigbee, isModernExtend: true};
}

export type iasZoneType = 'occupancy' | 'contact' | 'smoke' | 'water_leak' | 'carbon_monoxide' | 'sos' | 'vibration' | 'alarm' | 'gas' | 'generic';
export type iasZoneAttribute = 'alarm_1' | 'alarm_2' | 'tamper' | 'battery_low' | 'supervision_reports' | 'restore_reports' | 'ac_status' | 'test' |
    'battery_defect';
export interface IasArgs {
    zoneType: iasZoneType, zoneAttributes: iasZoneAttribute[], alarmTimeout?: boolean
}
export function iasZoneAlarm(args: IasArgs): ModernExtend {
    const exposeList = {
        'occupancy': e.binary('occupancy', ea.STATE, true, false).withDescription('Indicates whether the device detected occupancy'),
        'contact': e.binary('contact', ea.STATE, false, true).withDescription('Indicates whether the device is opened or closed'),
        'smoke': e.binary('smoke', ea.STATE, true, false).withDescription('Indicates whether the device detected smoke'),
        'water_leak': e.binary('water_leak', ea.STATE, true, false).withDescription('Indicates whether the device detected a water leak'),
        'carbon_monoxide': e.binary('carbon_monoxide', ea.STATE, true, false)
            .withDescription('Indicates whether the device detected carbon monoxide'),
        'sos': e.binary('sos', ea.STATE, true, false).withLabel('SOS').withDescription('Indicates whether the SOS alarm is triggered'),
        'vibration': e.binary('vibration', ea.STATE, true, false).withDescription('Indicates whether the device detected vibration'),
        'alarm': e.binary('alarm', ea.STATE, true, false).withDescription('Indicates whether the alarm is triggered'),
        'gas': e.binary('gas', ea.STATE, true, false).withDescription('Indicates whether the device detected gas'),
        'alarm_1': e.binary('alarm_1', ea.STATE, true, false).withDescription('Indicates whether IAS Zone alarm 1 is active'),
        'alarm_2': e.binary('alarm_2', ea.STATE, true, false).withDescription('Indicates whether IAS Zone alarm 2 is active'),
        'tamper': e.binary('tamper', ea.STATE, true, false).withDescription('Indicates whether the device is tampered').withCategory('diagnostic'),
        'battery_low': e.binary('battery_low', ea.STATE, true, false).withDescription('Indicates whether the battery of the device is almost empty')
            .withCategory('diagnostic'),
        'supervision_reports': e.binary('supervision_reports', ea.STATE, true, false)
            .withDescription('Indicates whether the device issues reports on zone operational status')
            .withCategory('diagnostic'),
        'restore_reports': e.binary('restore_reports', ea.STATE, true, false)
            .withDescription('Indicates whether the device issues reports on alarm no longer being present')
            .withCategory('diagnostic'),
        'ac_status': e.binary('ac_status', ea.STATE, true, false).withDescription('Indicates whether the device mains voltage supply is at fault')
            .withCategory('diagnostic'),
        'test': e.binary('test', ea.STATE, true, false).withDescription('Indicates whether the device is currently performing a test')
            .withCategory('diagnostic'),
        'battery_defect': e.binary('battery_defect', ea.STATE, true, false).withDescription('Indicates whether the device battery is defective')
            .withCategory('diagnostic'),
    };

    const exposes: Expose[] = [];
    const bothAlarms = args.zoneAttributes.includes('alarm_1') && (args.zoneAttributes.includes('alarm_2'));

    let alarm1Name = 'alarm_1';
    let alarm2Name = 'alarm_2';

    if (args.zoneType === 'generic') {
        args.zoneAttributes.map((attr) => exposes.push(exposeList[attr]));
    } else {
        if (bothAlarms) {
            exposes.push(e.binary(args.zoneType + '_alarm_1', ea.STATE, true, false)
                .withDescription(exposeList[args.zoneType].description + ' (alarm_1)'));
            alarm1Name = args.zoneType + '_alarm_1';
            exposes.push(e.binary(args.zoneType + '_alarm_2', ea.STATE, true, false)
                .withDescription(exposeList[args.zoneType].description + ' (alarm_2)'));
            alarm2Name = args.zoneType + '_alarm_2';
        } else {
            exposes.push(exposeList[args.zoneType]);
            alarm1Name = args.zoneType;
            alarm2Name = args.zoneType;
        }
        args.zoneAttributes.map((attr) => {
            if (attr !== 'alarm_1' && attr !== 'alarm_2') exposes.push(exposeList[attr]);
        });
    }

    const timeoutProperty = `${args.zoneType}_timeout`;

    const fromZigbee: Fz.Converter[] = [{
        cluster: 'ssIasZone',
        type: ['commandStatusChangeNotification', 'attributeReport', 'readResponse'],
        options: args.alarmTimeout ? [e.numeric(timeoutProperty, ea.SET).withValueMin(0)
            .withDescription(`Time in seconds after which ${args.zoneType} is cleared after detecting it (default 90 seconds).`)] : [],
        convert: (model, msg, publish, options, meta) => {
            const zoneStatus = msg.type === 'commandStatusChangeNotification' ? msg.data.zonestatus : msg.data.zoneStatus;

            if (args.alarmTimeout) {
                const timeout = options?.hasOwnProperty(timeoutProperty) ? Number(options[timeoutProperty]) : 90;
                clearTimeout(globalStore.getValue(msg.endpoint, 'timer'));
                if (timeout !== 0) {
                    const timer = setTimeout(() => publish({[alarm1Name]: false, [alarm2Name]: false}), timeout * 1000);
                    globalStore.putValue(msg.endpoint, 'timer', timer);
                }
            }

            return {
                [alarm1Name]: (zoneStatus & 1) > 0,
                [alarm2Name]: (zoneStatus & 1 << 1) > 0,
                tamper: (zoneStatus & 1 << 2) > 0,
                battery_low: (zoneStatus & 1 << 3) > 0,
                supervision_reports: (zoneStatus & 1 << 4) > 0,
                restore_reports: (zoneStatus & 1 << 5) > 0,
                trouble: (zoneStatus & 1 << 6) > 0,
                ac_status: (zoneStatus & 1 << 7) > 0,
                test: (zoneStatus & 1 << 8) > 0,
                battery_defect: (zoneStatus & 1 << 9) > 0,
            };
        },
    }];

    return {fromZigbee, exposes, isModernExtend: true};
}

export interface IasWarningArgs {
    reversePayload?: boolean,
}
export function iasWarning(args?: IasWarningArgs): ModernExtend {
    const warningMode = {'stop': 0, 'burglar': 1, 'fire': 2, 'emergency': 3, 'police_panic': 4, 'fire_panic': 5, 'emergency_panic': 6};
    // levels for siren, strobe and squawk are identical
    const level = {'low': 0, 'medium': 1, 'high': 2, 'very_high': 3};

    const exposes: Expose[] = [
        e.composite('warning', 'warning', ea.SET)
            .withFeature(e.enum('mode', ea.SET, Object.keys(warningMode)).withDescription('Mode of the warning (sound effect)'))
            .withFeature(e.enum('level', ea.SET, Object.keys(level)).withDescription('Sound level'))
            .withFeature(e.enum('strobe_level', ea.SET, Object.keys(level)).withDescription('Intensity of the strobe'))
            .withFeature(e.binary('strobe', ea.SET, true, false).withDescription('Turn on/off the strobe (light) during warning'))
            .withFeature(e.numeric('strobe_duty_cycle', ea.SET).withValueMax(10).withValueMin(0).withDescription('Length of the flash cycle'))
            .withFeature(e.numeric('duration', ea.SET).withUnit('s').withDescription('Duration in seconds of the alarm')),
    ];

    const toZigbee: Tz.Converter[] = [{
        key: ['warning'],
        convertSet: async (entity, key, value, meta) => {
            const values = {
                // @ts-expect-error
                mode: value.mode || 'emergency',
                // @ts-expect-error
                level: value.level || 'medium',
                // @ts-expect-error
                strobe: value.hasOwnProperty('strobe') ? value.strobe : true,
                // @ts-expect-error
                duration: value.hasOwnProperty('duration') ? value.duration : 10,
                // @ts-expect-error
                strobeDutyCycle: value.hasOwnProperty('strobe_duty_cycle') ? value.strobe_duty_cycle * 10 : 0,
                // @ts-expect-error
                strobeLevel: value.hasOwnProperty('strobe_level') ? utils.getFromLookup(value.strobe_level, strobeLevel) : 1,
            };

            let info;
            if (args?.reversePayload) {
                info = (getFromLookup(values.mode, warningMode)) + ((values.strobe ? 1 : 0) << 4) + (getFromLookup(values.level, level) << 6);
            } else {
                info = (getFromLookup(values.mode, warningMode) << 4) + ((values.strobe ? 1 : 0) << 2) + (getFromLookup(values.level, level));
            }

            const payload = {
                startwarninginfo: info,
                warningduration: values.duration,
                strobedutycycle: values.strobeDutyCycle,
                strobelevel: values.strobeLevel,
            };

            await entity.command('ssIasWd', 'startWarning', payload, getOptions(meta.mapped, entity));
        },
    }];
    return {toZigbee, exposes, isModernExtend: true};
}
