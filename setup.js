import { chromium } from 'playwright'
import path from 'path'

const userDataDir = './session';

(async () => {
  const browser = await chromium.launchPersistentContext(path.resolve(userDataDir), {
    headless: false
  })
  const page = await browser.newPage()
  await page.goto('https://photos.google.com/')

  console.log('Close browser once you are logged inside Google Photos')
})()
