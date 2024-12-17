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
const downloadPath = './download'

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

const getMonthAndYear = async (filePath, metadata, page) => {
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
    const dateString = await page.$eval('div[aria-label^="Date taken:"]', el => el.textContent.trim())
    console.log(`Metadata not found for in exif of ${filePath.split('/').pop()}, so getting from html: ${dateString}`)
    const date = new Date(dateString)
    if (date.toString() !== 'Invalid Date') {
      year = date.getFullYear()
      month = date.getMonth() + 1
      dateType = "HTML"
    }
  }
  return { year, month, dateType }
}

let FILE_PATH = ''
const downloadQueue = [];

const processQueue = async () => {
  while (downloadQueue.length > 0) {
    const itemsToDownload = downloadQueue.splice(0, 20);
    for (const item of itemsToDownload) {
      const cookieString = item.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
      const aria2cCommand = `aria2c --dir="${downloadPath}" --header "Cookie: ${cookieString}" --header "Referer: ${item.referer}" "${item.url}" --disable-ipv6=true -x 16 -k 1M'`;
      // console.log(`COMMAND: ${aria2cCommand}`);
      exec(aria2cCommand, async (error, stdout, stderr) => {
        if (error) {
          console.error(`Error executing aria2c: ${error}`);
          return;
        }

        FILE_PATH = stdout.match(/Download complete: (.*)/)?.[1]?.trim();

        if (stderr) {
          console.error(`aria2c stderr: ${stderr}`);
        }

        // Move the downloaded file to the respective date folder
        const filePath = FILE_PATH
        if (!fs.existsSync(filePath)) {
          console.log(`File does not exist: ${filePath}`);
          return;
        }
        if (!fs.existsSync(filePath)) {
          console.log(`File does not exist: ${filePath}`);
          return;
        }
        let metadata;
        if (fs.existsSync(filePath)) {
          metadata = await exiftool.read(filePath);
        }
        const date = await getMonthAndYear(filePath, metadata, item.page);
        const year = date.year;
        const month = date.month;
        try {
          let newPath = `${downloadPath}/${year}/${month}/${filePath.split('/').pop()}`;
          newPath = validatePath(newPath);
          await moveFile(filePath, newPath, { overwrite: true });
          console.log('Download Complete:', `${year}/${month}/${filePath.split('/').pop()}`);
        } catch (error) {
          const randomNumber = Math.floor(Math.random() * 1000000);
          let newPath = filePath.replace(/(\.[\w\d_-]+)$/i, `_${randomNumber}$1`);

          // check for long paths that could result in ENAMETOOLONG and truncate if necessary
          if (newPath.length > 225) {
            newPath = truncatePath(newPath)
          }

          await moveFile(filePath, newPath);
          console.log('Download Complete:', newPath);
        }
      });
    }
    await sleep(1000); // Add a delay to avoid overwhelming the system
  }
}

const addToQueue = async (url, cookies, referer, page) => {
  downloadQueue.push({ url, cookies, referer, page });
  await processQueue();
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
    await sleep(100)
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

    let retries = 3;
    const retryInterval = 1000;
    while (retries > 0) {
      try {
        await page.waitForURL((url) => {
          return url.host === 'photos.google.com' && url.href !== currentUrl;
        }, {
          timeout: timeoutValue,
        });
        break; // Exit loop if successful
      } catch (error) {
        retries--;
        console.error('Error waiting for URL:', error);
        if (retries === 0) {
          throw error;
        }
        await sleep(retryInterval);
        continue;
      }
    }


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

  downloadPromise.then(async download => {
    const downloadUrl = download.url();
    const cookies = await page.context().cookies([downloadUrl]);
    download.cancel();
    const referer = page.url();
    await addToQueue(downloadUrl, cookies, referer, page);
  }).catch(error => {
    console.log('Error while waiting for download:', error);
  });
}

/*
  This function is used to get the latest photo in the library. Once Page is loaded,
  We press right click, It will select the latest photo in the grid. And then
  we get the active element, which is the latest photo.
*/
const getLatestPhoto = async (page) => {
  await page.keyboard.press('ArrowRight')
  return await page.evaluate(() => document.activeElement.toString())
}

const clean = (link) => {
  return link.replace(/\/u\/\d+\//, '/')
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
