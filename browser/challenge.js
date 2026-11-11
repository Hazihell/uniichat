export async function challenge(page) {
  const text = await page.locator('body').innerText({ timeout: 5000 });
  const frames = page.frames().map(frame => frame.url()).join(' ');
  return /captcha|passkey|security key|verification code|authenticator|approve.{0,30}(sign.in|login)|two.factor/i.test(`${text} ${frames}`);
}
