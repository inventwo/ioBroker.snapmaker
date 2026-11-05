'use strict';

/*
 * Created with @iobroker/create-adapter v3.1.5
 * Snapmaker 2.0 HTTP API (port 8080)
 */

const utils = require('@iobroker/adapter-core');
const {
	SnapmakerApi,
	DEFAULT_PORT,
	normalizeProgress,
	formatHms,
	mapToolHead,
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
		this.tokenRejectLogged = false;
		this.unauthorizedLogged = false;
	}

	async onReady() {
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
		const toolHead = mapToolHead(data.toolHead);
		const laserPowerRaw = Math.max(0, Number(data.laserPower) || 0);
		const workSpeed = Math.max(0, Number(data.workSpeed) || 0);
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
		await this.setState('info.toolHead', toolHead || String(data.toolHead || ''), true);
		await this.setState('currentJob.fileName', fileName, true);
		await this.setState('currentJob.progress', progress, true);
		await this.setState('currentJob.elapsedTime', elapsed, true);
		await this.setState('currentJob.elapsedText', formatHms(elapsed), true);
		await this.setState('currentJob.remainingTime', remaining, true);
		await this.setState('currentJob.remainingText', formatHms(remaining), true);
		await this.setState('laser.power', laserPower, true);
		await this.setState('laser.powerRaw', laserPowerRaw, true);
		await this.setState('laser.on', laserPowerRaw > 0, true);
		await this.setState('laser.workSpeed', workSpeed, true);
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

		await this.ensureChannel('laser', 'Laser');
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
