import { chromium } from 'playwright-extra'
import stealth from 'puppeteer-extra-plugin-stealth'
import path from 'path'
import { moveFile } from 'move-file'
import fsP from 'node:fs/promises'
import fs from 'node:fs'
import { exiftool } from 'exiftool-vendored'
import ua from 'user-agents'
import { exec } from 'node:child_process'

const userAgent = new ua({
  platform: 'MacIntel', // 'Win32', 'Linux ...'
  deviceCategory: 'desktop', // 'mobile', 'tablet'
});

chromium.use(stealth())

const timeoutValue = 300000
const userDataDir = './session'
// const downloadPath = './download'
const downloadPath = './aria2-downloads'

let headless = true

// accept --headless=false argument to run in headful mode
if (process.argv[2] === '--headless=false') {
  headless = false
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const getProgress = async () => {
  try {
    const lastDone = await fsP.readFile('.lastdone', 'utf-8')
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
    await fsP.writeFile('.lastdone', currentUrl, 'utf-8');
  } else {
    console.log('Current URL does not start with https://photos.google.com, not saving progress.');
  }
}
const getMonthAndYear = async (metadata, page) => {
  let year = 1970
  let month = 1
  let dateType = "default"
  if (metadata.DateTimeOriginal) {
    year = metadata.DateTimeOriginal.year
    month = metadata.DateTimeOriginal.month
    dateType = "DateTimeOriginal"
  } else if (metadata.CreateDate) {
    year = metadata.CreateDate.year
    month = metadata.CreateDate.month
    dateType = "CreateDate"
  } else {
    // if metadata is not available, we try to get the date from the html
    console.log('Metadata not found, trying to get date from html')
    const data = await page.request.get(page.url())
    const html = await data.text()

    const regex = /aria-label="(Photo|Video) - (Landscape|Portrait|Square) - ([A-Za-z]{3} \d{1,2}, \d{4}, \d{1,2}:\d{2}:\d{2} [APM]{2})"/
    const match = regex.exec(html)

    if (match) {
      const dateString = match[3].replace(/\u202F/g, ' ') // Remove U+202F character
      const date = new Date(dateString)
      if (date.toString() !== 'Invalid Date') {
        year = date.getFullYear()
        month = date.getMonth() + 1
        dateType = "HTML"
      }
    }
  }
  return { year, month, dateType }
}

const printAria2cCommand = (url, cookies) => {
  const cookieString = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
  console.log(`aria2c --header "Cookie: ${cookieString}" "${url}" --disable-ipv6=true --dry-run`);
}

(async () => {
  const startLink = await getProgress() 
  console.log('Starting from:', new URL(startLink).href)

  const browser = await chromium.launchPersistentContext(path.resolve(userDataDir), {
    headless,
    channel: 'chromium',
    acceptDownloads: true,
    args: [
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-blink-features=AutomationControlled', 
      '--no-sandbox',         // May help in some environments
      '--disable-infobars',    // Prevent infobars
      '--disable-extensions',   // Disable extensions
      '--start-maximized',      // Start maximized
      '--window-size=1280,720'  // Set a specific window size
    ],
    userAgent: userAgent.toString(),
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
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
  let filePath = '';


  const downloadUsingAria2Promise = new Promise((resolve, reject) => {
    let downloadUrl = '';
    downloadPromise.then(async download => {
      downloadUrl = download.url();

      const cookies = await page.context().cookies([downloadUrl]);
      download.cancel();

      const cookieString = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
      const referer = page.url();
      exec(`aria2c --dir="./aria2-downloads" --header "Cookie: ${cookieString}" --header "Referer: ${referer}" "${downloadUrl}" --disable-ipv6=true | awk '/Download complete:/{print $NF}'`, (error, stdout, stderr) => {
        if (error) {
          console.error(`Error executing aria2c: ${error}`);
          reject(error);
          return;
        }

        console.log(`aria2c output: ${stdout}`);
        filePath = stdout.trim();
        
        if (stderr) {
          console.error(`aria2c stderr: ${stderr}`);
        }

        resolve(filePath);
      });
    }).catch(error => {
      console.log('Error while waiting for download:', error);
      reject(error);
    });
  });


  let download
  try {
    // download = await downloadPromise
    await downloadUsingAria2Promise;
  } catch (error) {
    console.log(error)
    console.log('There was an error while downloading the photo, Skipping...', page.url())
    return
  }

  const temp = filePath
  // const fileName = await download.suggestedFilename()
  const fileName = filePath.split('/').pop()

  // const metadata = await exiftool.read(temp)
  const metadata = await exiftool.read(filePath)

  const date = await getMonthAndYear(metadata, page)
  const year = date.year
  const month = date.month
  try {
    let path = `${downloadPath}/${year}/${month}/${fileName}`
    path = validatePath(path)
    

    await moveFile(temp, path, { overwrite })
    console.log('Download Complete:', `${year}/${month}/${fileName}`)
  } catch (error) {
    const randomNumber = Math.floor(Math.random() * 1000000)
    // const fileName = await download.suggestedFilename().replace(/(\.[\w\d_-]+)$/i, `_${randomNumber}$1`)
    const fileName = filePath.split('/').pop().replace(/(\.[\w\d_-]+)$/i, `_${randomNumber}$1`)
    var downloadFilePath = path

    // check for long paths that could result in ENAMETOOLONG and truncate if necessary
    if (downloadFilePath.length > 225) {
      downloadFilePath = truncatePath(downloadFilePath)
    }

    await moveFile(temp, `${downloadFilePath}`)
    console.log('Download Complete:', `${downloadFilePath}`)
    console.log('Download URL:', download.url())
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
  This function exists to avoid accidental file overwrites. 
  It checks if the path exists and if it does, we append a number- eg: _1 and set that as the new path
  while the new path exists, we increment the number
  when the path doesnt exist, we return the new path string.
*/
function validatePath(pathString) {
  let newPath = pathString;
  let counter = 1;

  while (fs.existsSync(newPath)) {
    const extensionIndex = newPath.lastIndexOf(".");
    const newPathWithoutExt = extensionIndex === -1 ? newPath : newPath.slice(0, extensionIndex);
    const extension = extensionIndex === -1 ? "" : newPath.slice(extensionIndex);
    newPath = `${newPathWithoutExt}_${counter}${extension}`;
    counter++;
  }

  return newPath;
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
