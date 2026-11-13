'use strict';

const http = require('node:http');

const DEFAULT_PORT = 8080;
const DEFAULT_TIMEOUT_MS = 10000;

/**
 * Normalize progress from Snapmaker status (0..1 or 0..100) to percent 0..100.
 *
 * @param {unknown} progress
 * @returns {number}
 */
function normalizeProgress(progress) {
	const n = Number(progress);
	if (!Number.isFinite(n) || n < 0) {
		return 0;
	}
	if (n <= 1) {
		return Math.round(n * 1000) / 10;
	}
	return Math.round(Math.min(n, 100) * 10) / 10;
}

/**
 * Format seconds as HH:MM:SS.
 *
 * @param {unknown} seconds
 * @returns {string}
 */
function formatHms(seconds) {
	let s = Math.max(0, Math.floor(Number(seconds) || 0));
	const h = Math.floor(s / 3600);
	s -= h * 3600;
	const m = Math.floor(s / 60);
	s -= m * 60;
	return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Estimated finish time from remaining seconds (local `YYYY-MM-DD HH:MM`).
 *
 * @param {unknown} remainingSec
 * @returns {string}
 */
function formatFinishAt(remainingSec) {
	const sec = Number(remainingSec);
	if (!Number.isFinite(sec) || sec <= 0) {
		return '';
	}
	const end = new Date(Date.now() + sec * 1000);
	const y = end.getFullYear();
	const m = String(end.getMonth() + 1).padStart(2, '0');
	const d = String(end.getDate()).padStart(2, '0');
	const hh = String(end.getHours()).padStart(2, '0');
	const mm = String(end.getMinutes()).padStart(2, '0');
	return `${y}-${m}-${d} ${hh}:${mm}`;
}

/**
 * Round machine coordinates to 0.001 mm.
 *
 * @param {unknown} value
 * @returns {number}
 */
function roundCoord(value) {
	const n = Number(value);
	if (!Number.isFinite(n)) {
		return 0;
	}
	return Math.round(n * 1000) / 1000;
}

/**
 * Coerce Snapmaker boolean-ish status fields.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function toBool(value) {
	if (typeof value === 'boolean') {
		return value;
	}
	if (typeof value === 'number') {
		return value !== 0;
	}
	if (typeof value === 'string') {
		const s = value.trim().toLowerCase();
		return s === 'true' || s === '1' || s === 'yes';
	}
	return false;
}

/**
 * Clamp a value to a whole percentage (0..100).
 *
 * @param {unknown} value Raw value from the machine
 * @returns {number} Integer percent between 0 and 100
 */
function toPercent(value) {
	const n = Number(value);
	if (!Number.isFinite(n)) {
		return 0;
	}
	return Math.round(Math.min(100, Math.max(0, n)));
}

/**
 * Normalize the `moduleList` object from the status payload.
 *
 * @param {unknown} moduleList Raw `moduleList` from `/api/v1/status`
 * @returns {{enclosure: boolean, rotary: boolean, emergencyStop: boolean, airPurifier: boolean}|null} `null` if the firmware does not report a module list
 */
function parseModuleList(moduleList) {
	if (!moduleList || typeof moduleList !== 'object' || Array.isArray(moduleList)) {
		return null;
	}
	const list = moduleList;
	return {
		enclosure: toBool(list.enclosure),
		rotary: toBool(list.rotaryModule),
		emergencyStop: toBool(list.emergencyStopButton),
		airPurifier: toBool(list.airPurifier),
	};
}

/**
 * Map numeric `headType` from POST `/api/v1/connect` (Luban SstpHttpChannel).
 * Status `toolHead` is often only `"LASER"` for both 1.6W and 10W — use this instead.
 *
 * | code | Module |
 * |------|--------|
 * | 1 | Print |
 * | 2 | CNC |
 * | 3 | 1.6W Laser |
 * | 4 | 10W Laser |
 * | 5 | Dual extruder |
 * | 6 | 20W Laser |
 * | 7 | 40W Laser |
 * | 8 | 200W CNC |
 * | 9 | 2W Red Laser |
 *
 * @param {unknown} headType
 * @returns {{ kind: string, label: string, modulePower: number }|null}
 */
function mapConnectHeadType(headType) {
	const code = Number(headType);
	if (!Number.isFinite(code)) {
		return null;
	}
	switch (code) {
		case 1:
		case 5:
			return { kind: 'Print', label: 'Print', modulePower: 0 };
		case 2:
		case 8:
			return { kind: 'CNC', label: 'CNC', modulePower: 0 };
		case 3:
			return { kind: 'Laser', label: '1.6W Laser', modulePower: 1.6 };
		case 4:
			return { kind: 'Laser', label: '10W Laser', modulePower: 10 };
		case 6:
			return { kind: 'Laser', label: '20W Laser', modulePower: 20 };
		case 7:
			return { kind: 'Laser', label: '40W Laser', modulePower: 40 };
		case 9:
			return { kind: 'Laser', label: '2W Laser', modulePower: 2 };
		default:
			return null;
	}
}

/**
 * Rated laser watts from an explicit wattage in a status/Marlin toolHead string.
 * Plain `"LASER"` alone is ambiguous (1.6W and 10W both use it on HTTP status) → `0`.
 *
 * @param {unknown} toolHead
 * @returns {number}
 */
function parseLaserModulePower(toolHead) {
	const raw = String(toolHead || '').toUpperCase();
	if (!raw || (!raw.includes('LASER') && !raw.includes('TOOLHEAD_LASER'))) {
		return 0;
	}
	const wattMatch = raw.match(/(\d+(?:\.\d+)?)\s*W/);
	if (wattMatch) {
		return Number(wattMatch[1]);
	}
	return 0;
}

/**
 * Map toolHead API value to a short label (keeps laser wattage when present).
 *
 * @param {unknown} toolHead
 * @returns {string}
 */
function mapToolHead(toolHead) {
	const raw = String(toolHead || '');
	if (!raw) {
		return '';
	}
	const upper = raw.toUpperCase();
	if (upper.includes('LASER') || upper.includes('TOOLHEAD_LASER')) {
		const watts = parseLaserModulePower(raw);
		if (watts > 0) {
			return `${watts}W Laser`;
		}
		return 'Laser';
	}
	if (upper.includes('CNC')) {
		return 'CNC';
	}
	if (upper.includes('3DPRINT') || upper.includes('PRINT') || upper === '3DP') {
		return 'Print';
	}
	return raw;
}

/**
 * Snapmaker device tokens are UUIDs (Luban `server.token`).
 *
 * @param {unknown} token
 * @returns {boolean}
 */
function isDeviceToken(token) {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(token || '').trim());
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isUnreachableError(err) {
	const msg = String((err && err.message) || err || '');
	const code = err && err.code;
	return (
		code === 'EHOSTUNREACH' ||
		code === 'ECONNREFUSED' ||
		code === 'ENOTFOUND' ||
		code === 'ETIMEDOUT' ||
		code === 'ECONNRESET' ||
		msg.includes('Timeout') ||
		msg.includes('EHOSTUNREACH') ||
		msg.includes('ECONNREFUSED')
	);
}

/** Snapmaker 2.0 HTTP API client (port 8080). */
class SnapmakerApi {
	/**
	 * @param {{host: string, port?: number, timeoutMs?: number}} opts
	 */
	constructor(opts) {
		this.host = opts.host;
		this.port = opts.port || DEFAULT_PORT;
		this.timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
		this.token = '';
	}

	/**
	 * @param {string} token
	 */
	setToken(token) {
		this.token = String(token || '').trim();
	}

	/**
	 * Low-level HTTP request.
	 *
	 * @param {string} method
	 * @param {string} pathAndQuery
	 * @param {string|null} [body]
	 * @param {Record<string, string>} [headers]
	 * @returns {Promise<{statusCode: number, body: string, json: any}>}
	 */
	request(method, pathAndQuery, body = null, headers = {}) {
		return new Promise((resolve, reject) => {
			const opts = {
				host: this.host,
				port: this.port,
				path: pathAndQuery,
				method,
				timeout: this.timeoutMs,
				headers: { ...headers },
			};
			if (body != null) {
				opts.headers['Content-Type'] = opts.headers['Content-Type'] || 'application/x-www-form-urlencoded';
				opts.headers['Content-Length'] = Buffer.byteLength(body);
			}

			const req = http.request(opts, res => {
				let data = '';
				res.setEncoding('utf8');
				res.on('data', chunk => {
					data += chunk;
				});
				res.on('end', () => {
					let json = null;
					const trimmed = data.trim();
					if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
						try {
							json = JSON.parse(trimmed);
						} catch {
							json = null;
						}
					}
					resolve({
						statusCode: res.statusCode || 0,
						body: data,
						json,
					});
				});
			});
			req.on('timeout', () => {
				req.destroy();
				reject(new Error('Timeout'));
			});
			req.on('error', reject);
			if (body != null) {
				req.write(body);
			}
			req.end();
		});
	}

	/**
	 * Establish / refresh session. Returns connect payload.
	 * When `token` is empty, Snapmaker issues a new token (touchscreen confirm may be required).
	 *
	 * @param {string} [token]
	 * @returns {Promise<{token: string, series?: string, headType?: number, readonly?: boolean, hasEnclosure?: boolean}>} headType: 3=1.6W laser, 4=10W laser, …
	 */
	async connect(token) {
		const useToken = token != null ? String(token).trim() : this.token;
		const body = useToken ? `token=${encodeURIComponent(useToken)}` : '';
		const res = await this.request('POST', '/api/v1/connect', body || null);

		if (res.statusCode === 403 || /someone trying to connect/i.test(res.body)) {
			const err = new Error(res.body.trim() || 'Connect slot busy');
			err.code = 'CONNECT_BUSY';
			throw err;
		}

		if (res.statusCode < 200 || res.statusCode >= 300 || !res.json || !res.json.token) {
			const err = new Error(`Connect failed HTTP ${res.statusCode}: ${res.body.slice(0, 200)}`);
			err.code = 'CONNECT_FAILED';
			throw err;
		}

		const returned = String(res.json.token);
		// If we sent a known device token and Snapmaker answers with a *different* UUID,
		// it started a new (unconfirmed) auth — do not adopt that token.
		if (useToken && isDeviceToken(useToken) && returned !== useToken) {
			const err = new Error('Configured API token was not accepted by the machine');
			err.code = 'TOKEN_REJECTED';
			err.returnedToken = returned;
			throw err;
		}

		this.token = returned;
		return res.json;
	}

	/**
	 * Poll machine status.
	 *
	 * @returns {Promise<{pending: boolean, unauthorized: boolean, data: object|null}>}
	 */
	async getStatus() {
		if (!this.token) {
			const err = new Error('No API token');
			err.code = 'NO_TOKEN';
			throw err;
		}
		const ts = Date.now();
		const res = await this.request('GET', `/api/v1/status?token=${encodeURIComponent(this.token)}&${ts}`);

		if (res.statusCode === 204 || !res.body.trim()) {
			return { pending: true, unauthorized: false, data: null };
		}
		if (res.statusCode === 401) {
			return { pending: false, unauthorized: true, data: null };
		}
		if (res.statusCode < 200 || res.statusCode >= 300) {
			const err = new Error(`Status failed HTTP ${res.statusCode}: ${res.body.slice(0, 200)}`);
			err.code = 'STATUS_FAILED';
			throw err;
		}
		if (!res.json) {
			return { pending: true, unauthorized: false, data: null };
		}
		return { pending: false, unauthorized: false, data: res.json };
	}

	/**
	 * Read enclosure state (`isReady`, `isDoorEnabled`, `led`, `fan`). Only available with an enclosure.
	 *
	 * @returns {Promise<Record<string, unknown>|null>} Enclosure payload, or `null` if unavailable
	 */
	async getEnclosure() {
		if (!this.token) {
			const err = new Error('No API token');
			err.code = 'NO_TOKEN';
			throw err;
		}
		const ts = Date.now();
		const res = await this.request('GET', `/api/v1/enclosure?token=${encodeURIComponent(this.token)}&${ts}`);
		if (res.statusCode < 200 || res.statusCode >= 300 || !res.json) {
			return null;
		}
		return res.json;
	}
}

module.exports = {
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
};
