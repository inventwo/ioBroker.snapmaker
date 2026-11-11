'use strict';

const { expect } = require('chai');
const {
	normalizeProgress,
	formatHms,
	mapToolHead,
	parseLaserModulePower,
	mapConnectHeadType,
	isDeviceToken,
	isUnreachableError,
} = require('./lib/snapmakerApi');

describe('snapmakerApi helpers', () => {
	it('normalizeProgress maps 0..1 to percent', () => {
		expect(normalizeProgress(0.256)).to.equal(25.6);
		expect(normalizeProgress(1)).to.equal(100);
	});

	it('normalizeProgress keeps 0..100 values', () => {
		expect(normalizeProgress(42)).to.equal(42);
		expect(normalizeProgress(0)).to.equal(0);
	});

	it('formatHms formats seconds', () => {
		expect(formatHms(0)).to.equal('00:00:00');
		expect(formatHms(3661)).to.equal('01:01:01');
	});

	it('mapToolHead maps known tool heads', () => {
		expect(mapToolHead('TOOLHEAD_LASER_2')).to.equal('Laser');
		expect(mapToolHead('10W LASER')).to.equal('10W Laser');
		expect(mapToolHead('TOOLHEAD_CNC_1')).to.equal('CNC');
		expect(mapToolHead('TOOLHEAD_3DPRINTING_1')).to.equal('Print');
	});

	it('parseLaserModulePower extracts rated watts only when explicit', () => {
		expect(parseLaserModulePower('10W LASER')).to.equal(10);
		expect(parseLaserModulePower('LASER')).to.equal(0);
		expect(parseLaserModulePower('40W LASER')).to.equal(40);
		expect(parseLaserModulePower('CNC')).to.equal(0);
	});

	it('mapConnectHeadType maps Luban SSTP headType codes', () => {
		expect(mapConnectHeadType(3)).to.deep.equal({ kind: 'Laser', label: '1.6W Laser', modulePower: 1.6 });
		expect(mapConnectHeadType(4)).to.deep.equal({ kind: 'Laser', label: '10W Laser', modulePower: 10 });
		expect(mapConnectHeadType(6)).to.deep.equal({ kind: 'Laser', label: '20W Laser', modulePower: 20 });
		expect(mapConnectHeadType(1)).to.deep.equal({ kind: 'Print', label: 'Print', modulePower: 0 });
		expect(mapConnectHeadType(99)).to.equal(null);
	});

	it('isUnreachableError detects network errors', () => {
		expect(isUnreachableError(Object.assign(new Error('fail'), { code: 'EHOSTUNREACH' }))).to.equal(
			true,
		);
		expect(isUnreachableError(new Error('Timeout'))).to.equal(true);
		expect(isUnreachableError(new Error('HTTP 500'))).to.equal(false);
	});

	it('isDeviceToken accepts Luban UUIDs only', () => {
		expect(isDeviceToken('528ec6f1-0646-44d9-8371-a1a51e66bb36')).to.equal(true);
		expect(isDeviceToken('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.x.y')).to.equal(false);
		expect(isDeviceToken('')).to.equal(false);
	});
});
