'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const subscriptionCheck = require('../subscription-check');
const { cancelRenewalAfterPayment } = require('../post-payment-renewal');

describe('支付成功后取消自动续费', () => {
    beforeEach(() => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => vi.restoreAllMocks());

    it('仅在读回关闭状态后报告取消成功', async () => {
        const cancel = vi.spyOn(subscriptionCheck, 'cancelAutoRenew').mockResolvedValue({ ok: true, data: { autoRenewRaw: false } });
        const result = await cancelRenewalAfterPayment('test-token', { email: 'test@example.test', retryDelayMs: 0 });
        expect(result.ok).toBe(true);
        expect(cancel).toHaveBeenCalledWith('test-token', { email: 'test@example.test' });
        expect(console.log).toHaveBeenCalledWith('AUTO_RENEW_CANCELLED');
    });

    it('新订阅状态未同步时重试，已关闭续费也视为完成', async () => {
        const cancel = vi.spyOn(subscriptionCheck, 'cancelAutoRenew')
            .mockResolvedValueOnce({ ok: false, statusCode: 400, error: '账号当前无有效订阅' })
            .mockResolvedValueOnce({ ok: true, data: { alreadyCancelled: true, autoRenewRaw: false } });
        expect((await cancelRenewalAfterPayment('test-token', { retryDelayMs: 0 })).ok).toBe(true);
        expect(cancel).toHaveBeenCalledTimes(2);
    });

    it('请求已提交但状态仍开启时不能报告取消成功', async () => {
        const cancel = vi.spyOn(subscriptionCheck, 'cancelAutoRenew').mockResolvedValue({ ok: true, data: { cancelled: true, autoRenewRaw: true } });
        expect((await cancelRenewalAfterPayment('test-token', { retryDelayMs: 0 })).ok).toBe(false);
        expect(cancel).toHaveBeenCalledTimes(3);
        expect(console.warn).toHaveBeenCalledWith('AUTO_RENEW_CANCEL_FAILED');
        expect(console.log).not.toHaveBeenCalledWith('AUTO_RENEW_CANCELLED');
    });

    it('查询状态不明时保留人工处理提示', async () => {
        vi.spyOn(subscriptionCheck, 'cancelAutoRenew').mockResolvedValue({ ok: true, data: { cancelled: true } });
        expect((await cancelRenewalAfterPayment('test-token', { retryDelayMs: 0 })).ok).toBe(false);
    });

    it('凭据过期时停止重试', async () => {
        const cancel = vi.spyOn(subscriptionCheck, 'cancelAutoRenew').mockResolvedValue({ ok: false, statusCode: 401, error: 'Session 无效或已过期' });
        expect((await cancelRenewalAfterPayment('test-token', { retryDelayMs: 0 })).ok).toBe(false);
        expect(cancel).toHaveBeenCalledTimes(1);
    });

    it('请求抛出异常也不会抛出支付失败或输出凭据', async () => {
        vi.spyOn(subscriptionCheck, 'cancelAutoRenew').mockRejectedValue(new Error('test-token'));
        expect((await cancelRenewalAfterPayment('test-token', { retryDelayMs: 0 })).ok).toBe(false);
        expect(console.warn.mock.calls.flat().join(' ')).not.toContain('test-token');
    });
});

describe('付款结果与续费结果分别展示', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const context = { extractRuntimeErrorMessage: () => '' };
    vm.createContext(context);
    vm.runInContext(source.slice(source.indexOf('function analyzeProcessOutput('), source.indexOf('function getCheckoutProgress(')), context);

    it.each([
        ['PAYMENT_SUCCESS\nAUTO_RENEW_CANCELLED', '激活成功，自动续费已关闭', false],
        ['PAYMENT_SUCCESS\nAUTO_RENEW_CANCEL_FAILED', '激活成功，但自动续费未确认关闭，请在续费管理中处理', false],
        ['PAYMENT_SUCCESS\nAUTO_RENEW_CANCEL_STARTED', '激活成功，但自动续费未确认关闭，请在续费管理中处理', false],
        ['PAYMENT_SUCCESS', '激活成功，但自动续费未确认关闭，请在续费管理中处理', true],
        ['PAYMENT_SUCCESS', '激活成功', false]
    ])('任务成功状态不因取消续费失败而重复扣款：%s', (output, message, timedOut) => {
        const result = context.analyzeProcessOutput(output, timedOut);
        expect(result.status).toBe('success');
        expect(result.shouldRetry).toBe(false);
        expect(result.message).toBe(message);
    });
});
