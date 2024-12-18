import { chromium } from 'playwright-extra'
import stealth from 'puppeteer-extra-plugin-stealth'
import path from 'path'
import { moveFile } from 'move-file'
import fsP from 'node:fs/promises'
import fs from 'node:fs'
import { exiftool } from 'exiftool-vendored'
import ua from 'user-agents'
import { exec } from 'node:child_process'
import term from 'terminal-kit'

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
    addLog('Current URL does not start with https://photos.google.com, not saving progress.', 'info');
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
    try {
      // if metadata is not available, we try to get the date from the html
      const dateString = await page.$eval('div[aria-label^="Date taken:"]', el => el.textContent.trim())
      addLog(`Metadata not found for in exif of ${filePath.split('/').pop()}, so getting from html: ${dateString}`, 'info')
      const date = new Date(dateString)
      if (date.toString() !== 'Invalid Date') {
        year = date.getFullYear()
        month = date.getMonth() + 1
        dateType = "HTML"
      }
    } catch (error) {
      addLog(`Failed to get date from HTML for ${filePath.split('/').pop()}: ${error.message}`, 'error')
      year = 1970
      month = 1
      dateType = "default"
    }
  }
  return { year, month, dateType }
}

let FILE_PATH = ''
const downloadQueue = [];
let activeDownloads = 0;

// Terminal UI Setup
const terminal = term.terminal
let activeDownloadList = []
let completedDownloadList = []
let logs = []

let totalDownloaded = 0

const renderUI = () => {
  terminal.clear()
  terminal.bold.underline('Downloading:\n')
  activeDownloadList.slice(-10).forEach((item) => {
    terminal.cyan(` - ${item.filename}\n`)
  })
  // Add padding if list is not full
  const activePadding = 10 - activeDownloadList.slice(-10).length
  for (let i = 0; i < activePadding; i++) {
    terminal('\n')
  }

  terminal.bold.underline(`\nDownloaded (${totalDownloaded}):\n`)
  completedDownloadList.slice(-10).forEach((item) => {
    if (item.status === 'Downloaded') {
      terminal.green(` - ${item.filename}\n`)
    } else if (item.status === 'Error' || item.status === 'File Not Found') {
      terminal.red(` - ${item.filename}: ${item.status}\n`)
    } else {
      terminal(` - ${item.filename}: ${item.status}\n`)
    }
  })
  // Add padding if list is not full
  const completedPadding = 10 - completedDownloadList.slice(-10).length
  for (let i = 0; i < completedPadding; i++) {
    terminal('\n')
  }

  terminal.bold.underline('\nLogs:\n')
  logs.slice(-20).forEach((log) => {
    const { message, type } = log;
    if (type === 'error') {
      terminal.red(` ${message}\n`)
    } else if (type === 'info') {
      terminal.yellow(` ${message}\n`)
    } else if (type === 'downloading') {
      terminal.yellow(` ${message}\n`)
    } else if (type === 'success') {
      terminal.green(` ${message}\n`)
    } else {
      terminal(` ${message}\n`)
    }
  })
  // Add padding if list is not full
  const logsPadding = 20 - logs.slice(-20).length
  for (let i = 0; i < logsPadding; i++) {
    terminal('\n')
  }

  terminal('\nPress Ctrl+C to exit.\n')
}

const updateUI = () => {
  renderUI()
}

const addToActiveDownloads = (filename) => {
  activeDownloadList.push({ filename, status: 'Downloading' })
  if (activeDownloadList.length > 10) {
    activeDownloadList.shift()
  }
  // addLog(`Started downloading ${filename}`, 'downloading')
  updateUI()
}

const addToCompletedDownloads = (filename, status) => {
  completedDownloadList.push({ filename, status })
  if (completedDownloadList.length > 10) {
    completedDownloadList.shift()
  }
  totalDownloaded += 1
  if (status === 'Downloaded') {
    // addLog(`Successfully downloaded ${filename}`, 'success')
  } else {
    addLog(`Failed to download ${filename}: ${status}`, 'error')
  }
  updateUI()
}

const addLog = (message, type = 'default') => {
  if (message.length > 100) {
    message = message.substring(0, 100) + '...';
  }
  logs.push({ message, type })
  if (logs.length > 20) {
    logs.shift()
  }
  updateUI()
}

const updateDownloadStatus = (filename, status) => {
  const download = activeDownloadList.find(item => item.filename === filename)
  if (download) {
    download.status = status
    addToCompletedDownloads(filename, status)
    activeDownloadList = activeDownloadList.filter(item => item.filename !== filename)
    updateUI()
  }
}

const removeFromActiveDownloads = (filename) => {
  activeDownloadList = activeDownloadList.filter(item => item.filename !== filename)
  updateUI()
}

const processQueue = async () => {
  while (downloadQueue.length > 0 && activeDownloads < 10) {
    const item = downloadQueue.shift();
    activeDownloads++;
    // Use --dry-run to get the filename
    const dryRunCommand = `aria2c --dry-run --dir="${downloadPath}" --header "Cookie: ${item.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ')}" --header "Referer: ${item.referer}" "${item.url}" --disable-ipv6=true`;
    exec(dryRunCommand, (error, stdout, stderr) => {
      if (error) {
        addLog(`Error executing aria2c dry-run: ${error}`, 'error')
        activeDownloads--;
        processQueue();
        return;
      }

      const filenameMatch = stdout.match(/Download complete: (.*)/)
      const filename = filenameMatch ? filenameMatch[1].trim() : 'Unknown'

      addToActiveDownloads(filename.split('/').pop())

      const aria2cCommand = `aria2c --dir="${downloadPath}" --header "Cookie: ${item.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ')}" --header "Referer: ${item.referer}" "${item.url}" --file-allocation=none --split=1 --disable-ipv6=true`;
      exec(aria2cCommand, async (error, stdout, stderr) => {
        activeDownloads--;
        if (error) {
          addLog(`Error executing aria2c: ${error}`, 'error')
          updateDownloadStatus(filename, 'Error')
          processQueue();
          return;
        }

        FILE_PATH = stdout.match(/Download complete: (.*)/)?.[1]?.trim();

        if (stderr) {
          addLog(`aria2c stderr: ${stderr}`, 'info')
        }

        // Move the downloaded file to the respective date folder
        const filePath = FILE_PATH
        if (!fs.existsSync(filePath)) {
          addLog(`File does not exist: ${filePath}`, 'error')
          updateDownloadStatus(filename, 'File Not Found')
          return;
        }
        if (!fs.existsSync(filePath)) {
          addLog(`File does not exist: ${filePath}`, 'error')
          updateDownloadStatus(filename, 'File Not Found')
          return;
        }
        let metadata;
        if (fs.existsSync(filePath)) {
          try { metadata = await exiftool.read(filePath); } catch (error) { addLog(`Error reading metadata: ${error}`, 'error'); }
        }
        const date = await getMonthAndYear(filePath, metadata, item.page);
        const year = date.year;
        const month = date.month;
        try {
          let newPath = `${downloadPath}/${year}/${month}/${filePath.split('/').pop()}`;
          newPath = validatePath(newPath);

          try {
            await moveFile(filePath, newPath, { overwrite: true });
          } catch (error) {
            addLog(`Error moving file: ${error.message}`, 'error')
          }

          // addLog(`Download Complete: ${year}/${month}/${filePath.split('/').pop()}`)
          updateDownloadStatus(filename.split('/').pop(), 'Downloaded')
        } catch (error) {
          const randomNumber = Math.floor(Math.random() * 1000000);
          let newPath = filePath.replace(/(\.[\w\d_-]+)$/i, `_${randomNumber}$1`);

          // check for long paths that could result in ENAMETOOLONG and truncate if necessary
          if (newPath.length > 225) {
            newPath = truncatePath(newPath)
          }

          try {
            await moveFile(filePath, newPath);
          } catch (error) {
            addLog(`Error moving file: ${error.message}`, 'error')
          }
          // addLog(`Download Complete: ${newPath}`)
          updateDownloadStatus(filename, 'Downloaded')
        }
        processQueue();
      });
    });
  }
}

const addToQueue = async (url, cookies, referer, page) => {
  if (downloadQueue.length < 15) {
    downloadQueue.push({ url, cookies, referer, page });
    await processQueue();
  }
}

;(async () => {
  const startLink = await getProgress()
  addLog(`Starting from: ${new URL(startLink).href}`, 'info')

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
  addLog(`Latest Photo: ${latestPhoto}`, 'info')
  addLog('-------------------------------------', 'info')

  await page.goto(clean(startLink))

  /*
    We download the first (Oldest) photo and overwrite it if it already exists. Otherwise running first time, it will skip the first photo.
  */
  await downloadPhoto(page, true)

  while (true) {
    await sleep(100)
    const currentUrl = await page.url()

    if (clean(currentUrl) === clean(latestPhoto)) {
      addLog('-------------------------------------', 'info')
      addLog('Reached the latest photo, exiting...', 'info')
      break
    }

    if (downloadQueue.length < 15 && activeDownloads < 10) {
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
          break // Exit loop if successful
        } catch (error) {
          retries--;
          addLog(`Error waiting for URL: ${error}`, 'error')
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
    download.cancel();
    let cookies;
    if (downloadUrl.includes('photos.fife.usercontent.google.com')) {
      cookies = await page.context().cookies([downloadUrl]);
    }
    else if (downloadUrl.includes('video-downloads.googleusercontent.com')) {
      cookies = await page.context().cookies();
    }
    const referer = page.url();
    await addToQueue(downloadUrl, cookies, referer, page);
  }).catch(error => {
    addLog(`Error while waiting for download: ${error}`, 'error')
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
