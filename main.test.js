'use strict';

const { expect } = require('chai');
const {
	normalizeProgress,
	formatHms,
	mapToolHead,
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
		expect(mapToolHead('TOOLHEAD_CNC_1')).to.equal('CNC');
		expect(mapToolHead('TOOLHEAD_3DPRINTING_1')).to.equal('Print');
	});

	it('isUnreachableError detects network errors', () => {
		expect(isUnreachableError(Object.assign(new Error('fail'), { code: 'EHOSTUNREACH' }))).to.equal(
			true,
		);
		expect(isUnreachableError(new Error('Timeout'))).to.equal(true);
		expect(isUnreachableError(new Error('HTTP 500'))).to.equal(false);
	});
});
