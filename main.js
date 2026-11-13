'use strict';

/*
 * Created with @iobroker/create-adapter v3.1.5
 * Snapmaker 2.0 HTTP API (port 8080)
 */

const utils = require('@iobroker/adapter-core');
const ioPack = require('./io-package.json');
const {
	SnapmakerApi,
	DEFAULT_PORT,
	normalizeProgress,
	formatHms,
	formatFinishAt,
	roundCoord,
	toBool,
	toPercent,
	parseModuleList,
	mapToolHead,
	parseLaserModulePower,
	mapConnectHeadType,
	isDeviceToken,
	isUnreachableError,
} = require('./lib/snapmakerApi');

class Snapmaker extends utils.Adapter {
	/**
	 * @param {Partial<utils.AdapterOptions>} [options]
	 */
	constructor(options) {
		super({
			...options,
			name: 'snapmaker',
		});
		this.on('ready', this.onReady.bind(this));
		this.on('unload', this.onUnload.bind(this));

		this.api = null;
		this.pollTimer = null;
		this.pollIntervalMs = 10000;
		this.stopping = false;
		this.polling = false;
		this.reachable = true;
		this.waitingForAuth = false;
		this.connectBusyLogged = false;
		this.sessionReady = false;
		/** Last non-zero laser power while a job is active (avoids 0% flicker between vectors). */
		this.lastLaserPower = 0;
		this.headInfo = null;
		/** Enclosure reported by connect (`hasEnclosure`) — enables the `/api/v1/enclosure` poll. */
		this.hasEnclosure = false;
		/** Enclosure detected via status `moduleList` or connect. */
		this.enclosureAvailable = false;
		this.tokenRejectLogged = false;
		this.unauthorizedLogged = false;
		this.systemLanguage = 'en';
	}

	async onReady() {
		try {
			const systemConfig = await this.getForeignObjectAsync('system.config');
			if (systemConfig?.common?.language) {
				this.systemLanguage = systemConfig.common.language;
			}
		} catch (err) {
			this.log.debug(`Could not read system language: ${err && err.message ? err.message : String(err)}`);
		}

		await this.ensureAdapterRootMeta();
		await this.ensureInstanceMeta();

		const host = String(this.config.host || '').trim();
		const pollInterval = Math.max(2, Number(this.config.pollInterval) || 10);
		this.pollIntervalMs = pollInterval * 1000;
		this.stopping = false;

		if (!host) {
			this.log.error('Please set the machine IP address in the adapter settings');
			await this.setState('info.connection', false, true);
			return;
		}

		this.api = new SnapmakerApi({
			host,
			port: DEFAULT_PORT,
			timeoutMs: 10000,
		});

		const token = await this.loadToken();
		if (token) {
			this.api.setToken(token);
		}

		await this.ensureObjects();
		await this.setState('info.connection', false, true);

		this.log.info(`Snapmaker adapter started → ${host}:${DEFAULT_PORT} (poll ${pollInterval}s)`);

		await this.poll().catch(err => this.logUnreachable(err));
		this.scheduleNextPoll();
	}

	/**
	 * Ensure the adapter root object (snapmaker) is typed as meta.folder.
	 * Must be done at runtime — objects with `_id: ""` in io-package.json only cover the instance namespace.
	 *
	 * @returns {Promise<void>}
	 */
	async ensureAdapterRootMeta() {
		const rootId = this.name;
		const titleLang = ioPack.common?.titleLang || {};
		const lang = this.systemLanguage || 'en';
		const metaObject = {
			type: 'meta',
			common: {
				name: titleLang[lang] || titleLang.en || rootId,
				type: 'meta.folder',
			},
			native: {},
		};

		const existing = await this.getForeignObjectAsync(rootId);
		if (!existing) {
			await this.setForeignObjectAsync(rootId, metaObject);
		} else if (existing.type !== 'meta') {
			await this.extendForeignObjectAsync(rootId, {
				type: 'meta',
				common: metaObject.common,
			});
		}
	}

	/**
	 * Ensure this instance namespace (snapmaker.N) is typed as meta.folder with localized title.
	 * Fixes existing installs created before the io-package instanceObjects meta entry.
	 *
	 * @returns {Promise<void>}
	 */
	async ensureInstanceMeta() {
		const titleLang = ioPack.common?.titleLang || {};
		const instanceId = this.namespace;
		const metaCommon = {
			name: titleLang,
			type: 'meta.folder',
		};

		const existing = await this.getForeignObjectAsync(instanceId);
		if (!existing) {
			await this.setForeignObjectAsync(instanceId, {
				type: 'meta',
				common: metaCommon,
				native: {},
			});
			return;
		}
		if (existing.type !== 'meta') {
			await this.extendForeignObjectAsync(instanceId, {
				type: 'meta',
				common: metaCommon,
			});
		}
	}

	/**
	 * @returns {Promise<string>}
	 */
	async loadToken() {
		try {
			const st = await this.getStateAsync('info.apiToken');
			if (st && st.val) {
				return String(st.val).trim();
			}
		} catch {
			// ignore
		}
		return '';
	}

	/**
	 * Persist token in an expert state (avoids adapter restart from native writes).
	 *
	 * @param {string} token
	 * @returns {Promise<void>}
	 */
	async saveToken(token) {
		const t = String(token || '').trim();
		if (!t) {
			return;
		}
		await this.ensureState('info.apiToken', '', {
			name: 'API token (stored)',
			type: 'string',
			role: 'state',
			expert: true,
		});
		const cur = await this.getStateAsync('info.apiToken');
		if (!cur || cur.val !== t) {
			await this.setState('info.apiToken', t, true);
		}
	}

	/**
	 * @returns {void}
	 */
	scheduleNextPoll() {
		if (this.stopping) {
			return;
		}
		if (this.pollTimer) {
			this.clearTimeout(this.pollTimer);
			this.pollTimer = null;
		}
		this.pollTimer = this.setTimeout(() => {
			this.pollTimer = null;
			this.poll()
				.catch(err => this.logUnreachable(err))
				.finally(() => this.scheduleNextPoll());
		}, this.pollIntervalMs);
	}

	/**
	 * @param {() => void} callback
	 */
	onUnload(callback) {
		try {
			this.stopping = true;
			if (this.pollTimer) {
				this.clearTimeout(this.pollTimer);
				this.pollTimer = null;
			}
			this.setState('info.connection', false, true);
			callback();
		} catch (error) {
			this.log.error(`Error during unload: ${error.message}`);
			callback();
		}
	}

	/**
	 * @param {unknown} err
	 */
	logUnreachable(err) {
		if (!isUnreachableError(err)) {
			this.log.warn(`Snapmaker poll error: ${(err && err.message) || err}`);
			return;
		}
		if (this.reachable) {
			this.reachable = false;
			this.log.info(`Snapmaker unreachable: ${(err && err.message) || err}`);
			this.setState('info.connection', false, true);
		}
	}

	/**
	 * Prefer configured token, then in-memory / stored expert state.
	 *
	 * @returns {Promise<string>}
	 */
	async resolveToken() {
		const fromConfig = String(this.config.apiToken || '').trim();
		if (fromConfig) {
			if (!isDeviceToken(fromConfig)) {
				if (!this.tokenRejectLogged) {
					this.tokenRejectLogged = true;
					this.log.error(
						'API token in settings is not a valid Snapmaker UUID (Luban machine.json → server.token). ' +
							'Re-enter the token after the encryption update and save the instance.',
					);
				}
			} else {
				return fromConfig;
			}
		}
		if (this.api && isDeviceToken(this.api.token)) {
			return this.api.token;
		}
		const stored = await this.loadToken();
		if (stored && isDeviceToken(stored)) {
			return stored;
		}
		return '';
	}

	/**
	 * @returns {Promise<void>}
	 */
	async poll() {
		if (this.stopping || this.polling || !this.api) {
			return;
		}
		this.polling = true;
		try {
			// Connect only to open/refresh a session — status polling alone keeps it alive.
			if (!this.sessionReady || !this.api.token) {
				await this.ensureSession();
			}
			if (!this.api.token) {
				await this.setState('info.connection', false, true);
				return;
			}

			const result = await this.api.getStatus();

			if (result.unauthorized) {
				this.sessionReady = false;
				if (!this.unauthorizedLogged) {
					this.unauthorizedLogged = true;
					this.log.info(
						'Snapmaker status unauthorized — reconnecting once (close Luban if this keeps happening)',
					);
				}
				await this.setState('info.connection', false, true);
				const known = await this.resolveToken();
				this.api.setToken(known || '');
				await this.ensureSession();
				if (this.api.token) {
					const retry = await this.api.getStatus();
					if (!retry.unauthorized && !retry.pending && retry.data) {
						this.unauthorizedLogged = false;
						this.sessionReady = true;
						await this.saveToken(this.api.token);
						await this.setState('info.connection', true, true);
						await this.publishStatus(retry.data);
					}
				}
				return;
			}

			if (result.pending) {
				if (!this.waitingForAuth) {
					this.waitingForAuth = true;
					this.log.info(
						'Waiting for Snapmaker authorization — confirm the connection on the touchscreen if prompted',
					);
				}
				await this.setState('info.connection', false, true);
				return;
			}

			if (this.waitingForAuth) {
				this.waitingForAuth = false;
				this.log.info('Snapmaker connection authorized');
			}

			if (!this.reachable) {
				this.reachable = true;
				this.log.info('Snapmaker is reachable again');
			}
			this.connectBusyLogged = false;
			this.unauthorizedLogged = false;
			this.tokenRejectLogged = false;

			this.sessionReady = true;
			await this.saveToken(this.api.token);
			await this.setState('info.connection', true, true);
			await this.publishStatus(result.data);
		} finally {
			this.polling = false;
		}
	}

	/**
	 * Connect with existing token or request a new one.
	 *
	 * @returns {Promise<void>}
	 */
	async ensureSession() {
		if (!this.api) {
			return;
		}
		try {
			const token = await this.resolveToken();
			if (token) {
				this.api.setToken(token);
			}
			const info = await this.api.connect(this.api.token || undefined);
			if (info && info.token) {
				this.api.setToken(info.token);
				await this.saveToken(info.token);
			}
			if (info && info.series) {
				await this.setState('info.series', String(info.series), true);
			}
			this.hasEnclosure = toBool(info && info.hasEnclosure);
			const mappedHead = mapConnectHeadType(info && info.headType);
			if (mappedHead) {
				this.headInfo = mappedHead;
				await this.setState('info.toolHead', mappedHead.label, true);
				await this.setState('laser.modulePower', mappedHead.modulePower, true);
			}
		} catch (err) {
			if (err && err.code === 'CONNECT_BUSY') {
				if (!this.connectBusyLogged) {
					this.connectBusyLogged = true;
					this.log.info('Snapmaker connect slot busy (another client connecting, e.g. Luban) — will retry');
				}
				return;
			}
			if (err && err.code === 'TOKEN_REJECTED') {
				if (!this.tokenRejectLogged) {
					this.tokenRejectLogged = true;
					this.log.error(
						'Snapmaker rejected the API token. Re-enter Luban server.token in the instance settings and save.',
					);
				}
				this.sessionReady = false;
				return;
			}
			throw err;
		}
	}

	/**
	 * @param {object|null} data
	 * @returns {Promise<void>}
	 */
	async publishStatus(data) {
		if (!data) {
			return;
		}

		const status = data.status != null ? String(data.status) : '';
		const printStatus = data.printStatus != null ? String(data.printStatus) : '';
		const fileName =
			data.fileName != null ? String(data.fileName) : data.filename != null ? String(data.filename) : '';
		const progress = normalizeProgress(data.progress);
		const elapsed = Math.max(0, Math.floor(Number(data.elapsedTime) || 0));
		const remaining = Math.max(0, Math.floor(Number(data.remainingTime) || 0));
		const toolHeadRaw = data.toolHead != null ? data.toolHead : null;
		const statusWatts = parseLaserModulePower(toolHeadRaw);
		const statusLabel = mapToolHead(toolHeadRaw);
		// Prefer connect headType (numeric) — status often only says "LASER" for 1.6W and 10W.
		const modulePower =
			statusWatts > 0
				? statusWatts
				: this.headInfo && this.headInfo.modulePower != null
					? this.headInfo.modulePower
					: 0;
		const toolHead =
			statusWatts > 0 ? statusLabel : this.headInfo && this.headInfo.label ? this.headInfo.label : statusLabel;
		const laserPowerRaw = Math.max(0, Number(data.laserPower) || 0);
		const workSpeed = Math.max(0, Number(data.workSpeed) || 0);
		const x = roundCoord(data.x);
		const y = roundCoord(data.y);
		const z = roundCoord(data.z);
		const homed = toBool(data.homed);
		const doorOpen = toBool(data.isEnclosureDoorOpen);
		const currentLine = Math.max(0, Math.floor(Number(data.currentLine) || 0));
		const totalLines = Math.max(0, Math.floor(Number(data.totalLines) || 0));
		const estimated = Math.max(0, Math.floor(Number(data.estimatedTime) || 0));
		const focalLength = roundCoord(data.laserFocalLength);
		const laserErrorState = Math.max(0, Math.floor(Number(data.laser10WErrorState) || 0));
		const laserCamera = toBool(data.laserCamera);
		const modules = parseModuleList(data.moduleList);
		this.enclosureAvailable = this.hasEnclosure || (modules !== null && modules.enclosure);
		const jobActive = status === 'RUNNING' || status === 'PAUSED';
		if (jobActive) {
			if (laserPowerRaw > 0) {
				this.lastLaserPower = laserPowerRaw;
			}
		} else {
			this.lastLaserPower = 0;
		}
		const laserPower = jobActive ? this.lastLaserPower : 0;

		await this.setState('status', status, true);
		await this.setState('printStatus', printStatus, true);
		await this.setState('info.toolHead', toolHead || String(toolHeadRaw || ''), true);
		await this.setState('laser.modulePower', modulePower, true);
		await this.setState('info.x', x, true);
		await this.setState('info.y', y, true);
		await this.setState('info.z', z, true);
		await this.setState('info.homed', homed, true);
		await this.setState('currentJob.fileName', fileName, true);
		await this.setState('currentJob.progress', progress, true);
		await this.setState('currentJob.elapsedTime', elapsed, true);
		await this.setState('currentJob.elapsedText', formatHms(elapsed), true);
		await this.setState('currentJob.remainingTime', remaining, true);
		await this.setState('currentJob.remainingText', formatHms(remaining), true);
		await this.setState('currentJob.estimatedTime', estimated, true);
		await this.setState('currentJob.estimatedText', formatHms(estimated), true);
		await this.setState('currentJob.finishAt', formatFinishAt(remaining), true);
		await this.setState('currentJob.currentLine', currentLine, true);
		await this.setState('currentJob.totalLines', totalLines, true);
		await this.setState('enclosure.doorOpen', doorOpen, true);
		await this.setState('laser.power', laserPower, true);
		await this.setState('laser.powerRaw', laserPowerRaw, true);
		await this.setState('laser.on', laserPowerRaw > 0, true);
		await this.setState('laser.workSpeed', workSpeed, true);
		await this.setState('laser.focalLength', focalLength, true);
		await this.setState('laser.errorState', laserErrorState, true);
		await this.setState('laser.camera', laserCamera, true);

		if (modules) {
			await this.setState('modules.enclosure', this.enclosureAvailable, true);
			await this.setState('modules.rotary', modules.rotary, true);
			await this.setState('modules.emergencyStop', modules.emergencyStop, true);
			await this.setState('modules.airPurifier', modules.airPurifier, true);
		}

		await this.publishEnclosure();
	}

	/**
	 * Poll `/api/v1/enclosure` (light, fan, door detection, ready). Failures never break the status poll.
	 *
	 * @returns {Promise<void>}
	 */
	async publishEnclosure() {
		if (!this.api || !this.enclosureAvailable) {
			return;
		}
		try {
			const enclosure = await this.api.getEnclosure();
			if (!enclosure) {
				return;
			}
			await this.setState('enclosure.ready', toBool(enclosure.isReady), true);
			await this.setState('enclosure.doorDetection', toBool(enclosure.isDoorEnabled), true);
			await this.setState('enclosure.light', toPercent(enclosure.led), true);
			await this.setState('enclosure.fan', toPercent(enclosure.fan), true);
		} catch (err) {
			this.log.debug(`Enclosure poll failed: ${err && err.message ? err.message : String(err)}`);
		}
	}

	/**
	 * @param {string} id
	 * @param {any} init
	 * @param {ioBroker.StateCommon} common
	 */
	async ensureState(id, init, common) {
		const existing = await this.getObjectAsync(id);
		const defaultRole = common.type === 'boolean' ? 'indicator' : common.type === 'string' ? 'text' : 'value';
		const fullCommon = {
			read: true,
			write: false,
			role: common.role || defaultRole,
			...common,
		};
		if (!existing) {
			await this.setObjectNotExistsAsync(id, {
				type: 'state',
				common: fullCommon,
				native: {},
			});
			const cur = await this.getStateAsync(id);
			if (cur === null || cur === undefined) {
				await this.setState(id, { val: init, ack: true });
			}
			return;
		}
		const patch = {};
		if (common.name && existing.common && existing.common.name !== common.name) {
			patch.name = common.name;
		}
		if (fullCommon.role && existing.common && existing.common.role !== fullCommon.role) {
			patch.role = fullCommon.role;
		}
		if (fullCommon.type && existing.common && existing.common.type !== fullCommon.type) {
			patch.type = fullCommon.type;
		}
		if (common.unit !== undefined && existing.common && existing.common.unit !== common.unit) {
			patch.unit = common.unit;
		}
		if (common.expert !== undefined && existing.common && existing.common.expert !== common.expert) {
			patch.expert = common.expert;
		}
		if (Object.keys(patch).length) {
			await this.extendObjectAsync(id, { common: patch });
		}
	}

	/**
	 * @param {string} id
	 * @param {string} name
	 */
	async ensureChannel(id, name) {
		await this.setObjectNotExistsAsync(id, {
			type: 'channel',
			common: { name },
			native: {},
		});
	}

	async ensureObjects() {
		await this.ensureState('info.series', '', { name: 'Machine series', type: 'string' });
		await this.ensureState('info.toolHead', '', { name: 'Tool head', type: 'string' });
		await this.ensureState('info.x', 0, { name: 'X position', type: 'number', unit: 'mm', role: 'value' });
		await this.ensureState('info.y', 0, { name: 'Y position', type: 'number', unit: 'mm', role: 'value' });
		await this.ensureState('info.z', 0, { name: 'Z position', type: 'number', unit: 'mm', role: 'value' });
		await this.ensureState('info.homed', false, { name: 'Axes homed', type: 'boolean', role: 'indicator' });
		await this.ensureState('info.apiToken', '', {
			name: 'API token (stored)',
			type: 'string',
			role: 'state',
			expert: true,
		});

		await this.ensureState('status', '', { name: 'Machine status', type: 'string' });
		await this.ensureState('printStatus', '', { name: 'Print / job status', type: 'string' });

		await this.ensureChannel('currentJob', 'Current job');
		await this.ensureState('currentJob.fileName', '', { name: 'Job file name', type: 'string' });
		await this.ensureState('currentJob.progress', 0, {
			name: 'Progress',
			type: 'number',
			unit: '%',
			role: 'value',
		});
		await this.ensureState('currentJob.elapsedTime', 0, {
			name: 'Elapsed time',
			type: 'number',
			unit: 's',
			role: 'value',
		});
		await this.ensureState('currentJob.elapsedText', '00:00:00', {
			name: 'Elapsed time (text)',
			type: 'string',
		});
		await this.ensureState('currentJob.remainingTime', 0, {
			name: 'Remaining time',
			type: 'number',
			unit: 's',
			role: 'value',
		});
		await this.ensureState('currentJob.remainingText', '00:00:00', {
			name: 'Remaining time (text)',
			type: 'string',
		});
		await this.ensureState('currentJob.estimatedTime', 0, {
			name: 'Estimated total time',
			type: 'number',
			unit: 's',
			role: 'value',
		});
		await this.ensureState('currentJob.estimatedText', '00:00:00', {
			name: 'Estimated total time (text)',
			type: 'string',
		});
		await this.ensureState('currentJob.finishAt', '', {
			name: 'Finish at (local YYYY-MM-DD HH:MM)',
			type: 'string',
		});
		await this.ensureState('currentJob.currentLine', 0, {
			name: 'Current G-code line',
			type: 'number',
			role: 'value',
		});
		await this.ensureState('currentJob.totalLines', 0, {
			name: 'Total G-code lines',
			type: 'number',
			role: 'value',
		});

		await this.ensureChannel('enclosure', 'Enclosure');
		await this.ensureState('enclosure.doorOpen', false, {
			name: 'Enclosure door open',
			type: 'boolean',
			role: 'indicator',
		});
		await this.ensureState('enclosure.ready', false, {
			name: 'Enclosure ready',
			type: 'boolean',
			role: 'indicator',
		});
		await this.ensureState('enclosure.doorDetection', false, {
			name: 'Enclosure door detection enabled',
			type: 'boolean',
			role: 'indicator',
		});
		await this.ensureState('enclosure.light', 0, {
			name: 'Enclosure light',
			type: 'number',
			unit: '%',
			role: 'level',
		});
		await this.ensureState('enclosure.fan', 0, {
			name: 'Enclosure fan',
			type: 'number',
			unit: '%',
			role: 'level',
		});

		await this.ensureChannel('modules', 'Connected modules');
		await this.ensureState('modules.enclosure', false, {
			name: 'Enclosure attached',
			type: 'boolean',
			role: 'indicator',
		});
		await this.ensureState('modules.rotary', false, {
			name: 'Rotary module attached',
			type: 'boolean',
			role: 'indicator',
		});
		await this.ensureState('modules.emergencyStop', false, {
			name: 'Emergency stop button attached',
			type: 'boolean',
			role: 'indicator',
		});
		await this.ensureState('modules.airPurifier', false, {
			name: 'Air purifier attached',
			type: 'boolean',
			role: 'indicator',
		});

		await this.ensureChannel('laser', 'Laser');
		await this.ensureState('laser.modulePower', 0, {
			name: 'Laser module rated power',
			type: 'number',
			unit: 'W',
			role: 'value',
		});
		await this.ensureState('laser.power', 0, {
			name: 'Laser power (last active during job)',
			type: 'number',
			unit: '%',
			role: 'level',
		});
		await this.ensureState('laser.powerRaw', 0, {
			name: 'Laser power (live)',
			type: 'number',
			unit: '%',
			role: 'level',
		});
		await this.ensureState('laser.on', false, {
			name: 'Laser firing',
			type: 'boolean',
			role: 'indicator.working',
		});
		await this.ensureState('laser.workSpeed', 0, {
			name: 'Work speed',
			type: 'number',
			unit: 'mm/min',
			role: 'value',
		});
		await this.ensureState('laser.focalLength', 0, {
			name: 'Laser focal length',
			type: 'number',
			unit: 'mm',
			role: 'value',
		});
		await this.ensureState('laser.errorState', 0, {
			name: 'Laser error state (0 = OK)',
			type: 'number',
			role: 'value',
		});
		await this.ensureState('laser.camera', false, {
			name: 'Laser camera detected',
			type: 'boolean',
			role: 'indicator',
		});
	}
}

if (require.main !== module) {
	/**
	 * @param {Partial<utils.AdapterOptions>} [options]
	 */
	module.exports = options => new Snapmaker(options);
} else {
	new Snapmaker();
}
