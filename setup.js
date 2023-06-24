import path from 'path'
import { chromium } from 'playwright-extra'
import stealth from 'puppeteer-extra-plugin-stealth'

chromium.use(stealth())

const userDataDir = './session';

(async () => {
  const browser = await chromium.launchPersistentContext(path.resolve(userDataDir), {
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  })
  const page = await browser.newPage()
  await page.goto('https://photos.google.com/')

  console.log('Close browser once you are logged inside Google Photos')
})()
