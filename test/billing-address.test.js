'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function loadModule(filename, mockRequire = createRequire(path.join(__dirname, '..', 'stripe-payment.js'))) {
    const context = { module: { exports: {} }, require: mockRequire, console, process, setTimeout };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', filename), 'utf8'), context);
    return context;
}

describe('数据库账单地址与国家校验', () => {
    it('实际国家为菲律宾时不能被旧的填写成功标志覆盖', () => {
        const context = loadModule('stripe-payment.js');
        expect(context.getBillingFieldStatus({ country: 'Philippines' }, { country: true }).country).toBe(false);
        expect(context.getBillingFieldStatus({ country: '' }, { country: true }).country).toBe(false);
        for (const country of ['US', 'United States', '美国']) {
            expect(context.getBillingFieldStatus({ country }).country).toBe(true);
        }
    });

    it('国家切换失败后不写入州和邮编', async () => {
        const context = loadModule('stripe-payment.js');
        context.getCurrentBillingCountryValue = async () => ({ value: 'PH', label: 'Philippines' });
        context.selectBillingCountry = async () => false;
        context.selectFirstVisibleSelect = () => { throw new Error('不应填写州'); };
        context.fillFirstVisibleSelector = () => { throw new Error('不应填写邮编'); };
        const result = await context.fillOpenAiBillingDirect({}, { country: 'US', state: 'DE', postal_code: '19801' }, 'Test');
        expect(result.country).toBe(false);
        expect(result.postal).toBe(false);
    });

    it('旧的非空地址不能替代数据库配置地址', () => {
        const context = loadModule('stripe-payment.js');
        const address = { line1: 'Configured street', city: 'Configured city', state: 'DE', postal_code: '19801' };
        const status = context.getBillingFieldStatus(
            { country: 'US', line1: 'Market Road', city: 'Corcuera', state: 'Romblon', postal: '19801' },
            { line1: true, city: true, state: true },
            address
        );
        expect(status.line1).toBe(false);
        expect(status.city).toBe(false);
        expect(status.state).toBe(false);
        expect(status.postal).toBe(true);
        expect(context.getBillingFieldStatus({ country: 'US', ...address, postal: '19801' }, {}, address).state).toBe(true);
    });

    it('无效邮编先返回地址校验错误，不进入税额重算', async () => {
        const context = loadModule('stripe-payment.js');
        context.readCheckoutDueAmount = () => { throw new Error('不应读取金额'); };
        const page = {
            getByText: pattern => ({ first: () => ({ isVisible: async () => pattern.test('Your postal code is invalid.') }) })
        };
        const result = await context.ensureCheckoutTaxFreeAmount(page, {}, 1100);
        expect(result.ok).toBe(false);
        expect(result.error).toContain('账单地址校验未通过');
    });

    it('城市和邮编的旧值会被配置值覆盖', async () => {
        for (const [previous, configured] of [['Corcuera', 'Configured city'], ['5501', '19801']]) {
            const context = loadModule('stripe-payment.js');
            let value = previous;
            const field = {
                inputValue: async () => value,
                scrollIntoViewIfNeeded: async () => {},
                click: async () => {},
                fill: async text => { value = text; }
            };
            context.findBillingControl = async () => field;
            context.resolveElementTag = async () => 'input';
            context.dismissAddressAutocomplete = async () => {};
            expect(await context.fillBillingControl({}, [/city/], configured, '账单字段')).toBe(true);
            expect(value).toBe(configured);
        }
    });

    it('已有街道与配置不一致时仍执行覆盖填写', async () => {
        const context = loadModule('stripe-payment.js');
        let line1 = 'Market Road';
        context.readBillingInputValues = async () => ({ line1 });
        context.suppressGoogleAddressAutocomplete = async () => {};
        context.dismissAddressAutocomplete = async () => {};
        const field = {
            count: async () => 1,
            evaluate: async () => 'input',
            isVisible: async () => true,
            inputValue: async () => line1,
            scrollIntoViewIfNeeded: async () => {},
            click: async () => {},
            fill: async value => { line1 = value; }
        };
        const page = { locator: () => ({ first: () => field }) };
        expect(await context.fillBillingLine1Strict(page, 'Configured street')).toBe(true);
        expect(line1).toBe('Configured street');
    });

    it('使用数据库地址并保留地址编号和邮编', async () => {
        const address = { id: 42, line1: 'Configured street', city: 'Configured city', state: 'DE', postal_code: '19801', country: 'US' };
        const store = { runQuery: vi.fn().mockResolvedValue([address]), setAppConfigValue: vi.fn() };
        const context = loadModule('tax-free-address.js', () => store);
        const result = await context.module.exports.pickBillingAddressForCheckout();
        expect(result).toEqual({ ...address, state: 'Delaware' });
        expect(store.runQuery.mock.calls[0][1]).toEqual(['US']);
    });

    it('数据库空池或查询失败时不生成替代地址', async () => {
        for (const query of [vi.fn().mockResolvedValue([]), vi.fn().mockRejectedValue(new Error('数据库不可用'))]) {
            const context = loadModule('tax-free-address.js', () => ({ runQuery: query }));
            context.generateRandomUsTaxFreeAddress = () => { throw new Error('不应生成地址'); };
            await expect(context.module.exports.pickBillingAddressForCheckout()).rejects.toThrow();
        }
    });
});
