const { chromium } = require('playwright')
const path = require('path')

const userDataDir = './session'
const downloadsPath = './downloads';

(async () => {
  const browser = await chromium.launchPersistentContext(path.resolve(userDataDir), {
    headless: false,
    acceptDownloads: true,
    javaScriptEnabled: true,
    downloadsPath: path.resolve(downloadsPath)
  })
  const page = await browser.newPage()
  await page.goto('https://photos.google.com/')

  console.log('Close browser once you are logged inside Google Photos')
})()
