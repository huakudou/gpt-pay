'use strict';

const subscriptionCheck = require('./subscription-check');

/** 支付成功后关闭自动续费，必须读回已关闭状态才算完成。 */
async function cancelRenewalAfterPayment(accessToken, options = {}) {
    const { retryDelayMs = 2000, ...requestOptions } = options;
    let error = '自动续费状态尚未确认关闭';
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        console.log(`[续费] 正在关闭自动续费（${attempt}/3）...`);
        try {
            const result = await subscriptionCheck.cancelAutoRenew(accessToken, requestOptions);
            if (result.ok && result.data?.autoRenewRaw === false) {
                console.log('[续费] 已确认自动续费关闭，当前订阅周期仍可使用');
                console.log('AUTO_RENEW_CANCELLED');
                return { ok: true };
            }
            error = result.error || '取消请求已提交，但未读回自动续费关闭状态';
            // 凭据无效时继续重试无法恢复，交给后台续费管理处理。
            if (result.statusCode === 401 || !accessToken) break;
        } catch (_) {
            error = '取消自动续费请求异常';
        }
        if (attempt < 3) await new Promise(resolve => setTimeout(resolve, retryDelayMs));
    }
    console.warn(`[续费] 自动续费未确认关闭，请在后台续费管理中处理：${error}`);
    console.warn('AUTO_RENEW_CANCEL_FAILED');
    return { ok: false, error };
}

module.exports = { cancelRenewalAfterPayment };
