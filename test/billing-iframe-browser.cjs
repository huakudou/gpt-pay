const vm = require('node:vm');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const context = { module: { exports: {} }, require: id => require(id.startsWith('./') ? '../' + id.slice(2) : id), console, process, setTimeout };
vm.createContext(context);
vm.runInContext(fs.readFileSync('stripe-payment.js', 'utf8'), context);
// 本地表单不连接税费服务，只验证真实浏览器中的填写和读回。
context.waitForCheckoutTaxRecalculation = async () => ({ ok: true });
(async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        const page = await browser.newPage();
        const form = '<label>Full name<input id="billingAddress-nameInput" value="Previous name"></label><label>Country or region<select id="billingAddress-countryInput" style="display:none"><option value="PH">Philippines</option><option value="US">United States</option></select></label><label>Address line 1<input id="billingAddress-addressLine1Input" value="Market Road"></label><label>City<input id="billingAddress-localityInput" value="Corcuera"></label><label>Postal code<input id="billingAddress-postalCodeInput" value="5501"></label><label>State<select id="billingAddress-administrativeAreaInput"><option value="MT">Montana</option></select></label>';
        await page.setContent('<h2>Billing address</h2><label>Country or region<select name="country"><option value="US">United States</option></select></label><iframe width="900" height="650" srcdoc="' + form.replaceAll('"', '&quot;') + '"></iframe>');
        assert.equal(await context.waitForBillingFields(page, 1500), true);
        assert.equal((await context.getCurrentBillingCountryValue(page)).value, 'PH');
        const address = { country: 'US', line1: 'Configured street', city: 'Bozeman', state: 'MT', postal_code: '59715' };
        const filled = await context.fillOpenAiBillingDirect(page, address, 'Configured name');
        const actual = await context.readBillingInputValues(page);
        assert.equal(context.listBillingMissing(context.getBillingFieldStatus(actual, filled, address)).length, 0);
        assert.equal(actual.country, 'US');
        assert.equal(actual.line1, address.line1);
        assert.equal(actual.city, address.city);
        assert.equal(actual.postal, address.postal_code);
        console.log('PASS: 主页面 US 不掩盖 iframe PH；iframe 账单字段完整覆盖并读回');
        const frame = page.frames().find(frame => frame !== page.mainFrame());
        await frame.locator('body').evaluate(body => { const error = document.createElement('p'); error.textContent = 'Your postal code is invalid.'; body.appendChild(error); });
        assert.equal(await context.hasBillingValidationError(page), true);
        console.log('PASS: iframe 内邮编错误可被正确识别');
        const custom = '<button role="combobox" aria-label="Country or region" onclick="document.querySelector(\'aside\').hidden=false">Philippines</button><aside hidden><button role="option" onclick="document.querySelector(\'[role=combobox]\').textContent=\'United States\';this.parentElement.hidden=true">United States</button></aside><input id="billingAddress-addressLine1Input">';
        await page.setContent('<select name="country"><option value="US">United States</option></select><iframe srcdoc="' + custom.replaceAll('"', '&quot;') + '"></iframe>');
        assert.equal((await context.getCurrentBillingCountryValue(page)).label, 'Philippines');
        assert.equal(await context.selectBillingCountry(page, ['United States', 'US']), true);
        assert.equal((await context.getCurrentBillingCountryValue(page)).label, 'United States');
        console.log('PASS: iframe 标签式自定义国家下拉在同一文档选择并读回');
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
