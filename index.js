import { chromium } from 'playwright-extra'
import stealth from 'puppeteer-extra-plugin-stealth'
import path from 'path'
import { moveFile } from 'move-file'
import fsP from 'node:fs/promises'
import { exiftool } from 'exiftool-vendored'

chromium.use(stealth())

const timeoutValue = 30000
const userDataDir = '/data/session'
const downloadPath = '/data/download'

let headless = true

// accept --headless=false argument to run in headful mode
if (process.argv[2] === '--headless=false') {
  headless = false
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const getProgress = async () => {
  try {
    const lastDone = await fsP.readFile('/data/.lastdone', 'utf-8')
    if (lastDone === '') throw new Error('Please add the starting link in .lastdone file')
    return lastDone
  } catch (error) {
    throw new Error(error)
  }
}

const saveProgress = async (page) => {
  const currentUrl = await page.url();
  // Only save if the URL is a valid Google Photos URL 'https://photos.google.com'
  if (currentUrl.startsWith('https://photos.google.com')) {
    await fsP.writeFile('/data/.lastdone', currentUrl, 'utf-8');
  } else {
    console.log('Current URL does not start with https://photos.google.com, not saving progress.');
  }
}

(async () => {
  const startLink = await getProgress()
  console.log('Starting from:', new URL(startLink).href)

  const browser = await chromium.launchPersistentContext(path.resolve(userDataDir), {
    headless,
    acceptDownloads: true,
    channel: 'chrome', // possible values: chrome, msedge and chromium
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  })

  const page = await browser.newPage()

  await page.goto('https://photos.google.com')

  const latestPhoto = await getLatestPhoto(page)
  console.log('Latest Photo:', latestPhoto)
  console.log('-------------------------------------')

  await page.goto(clean(startLink))

  /*
    We download the first (Oldest) photo and overwrite it if it already exists. Otherwise running first time, it will skip the first photo.
  */
  await downloadPhoto(page, true)

  while (true) {
    const currentUrl = await page.url()

    if (clean(currentUrl) === clean(latestPhoto)) {
      console.log('-------------------------------------')
      console.log('Reached the latest photo, exiting...')
      break
    }

    /*
      We click on the left side of arrow in the html. This will take us to the previous photo.
      Note: I have tried both left arrow press and clicking directly the left side of arrow using playwright click method.
      However, both of them are not working. So, I have injected the click method in the html.
    */
    await page.evaluate(() => document.getElementsByClassName('SxgK2b OQEhnd')[0].click())

    // we wait until new photo is loaded
    await page.waitForURL((url) => {
      return url.host === 'photos.google.com' && url.href !== currentUrl
    },
      {
        timeout: timeoutValue,
      })

    await downloadPhoto(page)
    await saveProgress(page)
  }
  await browser.close()
  await exiftool.end()
})()

const downloadPhoto = async (page, overwrite = false) => {
  const downloadPromise = page.waitForEvent('download', {
    timeout: timeoutValue
  })

  await page.keyboard.down('Shift')
  await page.keyboard.press('KeyD')

  let download
  try {
    download = await downloadPromise
  } catch (error) {
    console.log('There was an error while downloading the photo, Skipping...', page.url())
    return
  }

  const temp = await download.path()
  const fileName = await download.suggestedFilename()

  const metadata = await exiftool.read(temp)

  let year = metadata.DateTimeOriginal?.year || 1970
  let month = metadata.DateTimeOriginal?.month || 1

  if (year === 1970 && month === 1) {
    // if metadata is not available, we try to get the date from the html
    console.log('Metadata not found, trying to get date from html')
    const data = await page.request.get(page.url())
    const html = await data.text()

    const regex = /aria-label="(Photo . Landscape|Photo . Portrait|Video . Landscape|Video . Portrait|Video|Photo) . ([^"]+)"/
    const match = regex.exec(html)

    if (match) {
      const dateString = match[1]
      const date = new Date(dateString)
      year = date.getFullYear()
      month = date.getMonth() + 1
    }
  }

  try {
    await moveFile(temp, `${downloadPath}/${year}/${month}/${fileName}`, { overwrite })
    console.log('Download Complete:', `${year}/${month}/${fileName}`)
  } catch (error) {
    const randomNumber = Math.floor(Math.random() * 1000000)
    const fileName = await download.suggestedFilename().replace(/(\.[\w\d_-]+)$/i, `_${randomNumber}$1`)

    var downloadFilePath = `${downloadPath}/${year}/${month}/${fileName}`

    // check for long paths that could result in ENAMETOOLONG and truncate if necessary
    if (downloadFilePath.length > 225) {
      downloadFilePath = truncatePath(downloadFilePath)
    }

    await moveFile(temp, `${downloadFilePath}`)
    console.log('Download Complete:', `${downloadFilePath}`)
  }
}

/*
  This function truncates the filename (retaining the file extension) to avoid ENAMETOOLONG errors with long filenames
*/
function truncatePath(pathString) {
  const pathStringSplit = pathString.split(".");
  var fileExtension = pathStringSplit[pathStringSplit.length - 1];
  var fileExtensionLength = fileExtension.length + 1;
  var truncatedPath = pathString.substring(0, 225 - fileExtensionLength) + "." + fileExtension;

  return truncatedPath;
}

/*
  This function is used to get the latest photo in the library. Once Page is loaded,
  We press right click, It will select the latest photo in the grid. And then
  we get the active element, which is the latest photo.
*/
const getLatestPhoto = async (page) => {
  await page.keyboard.press('ArrowRight')
  await sleep(500)
  return await page.evaluate(() => document.activeElement.toString())
}

// remove /u/0/
const clean = (link) => {
  return link.replace(/\/u\/\d+\//, '/')
}
