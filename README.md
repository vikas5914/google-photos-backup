<div align="center">
<h1>Google Photos Backup <a href=""><img alt="npm" src="https://img.shields.io/github/package-json/v/vikas5914/google-photos-backup/master"></a></h1>
</div>

# Why?

Google recently closed Google Domain, which made me think about my photos. I have more than 10k photos on Google Photos, and I don't want to download them one by one.

Currently, the Google Photos API does not allow downloading photos in their original quality. Google Takeout is slow and manual, and it does not support incremental photo downloads.

So, I was looking for a solution to download all my photos in their original quality and incrementally. I found [gphotos-cdp](https://github.com/perkeep/gphotos-cdp), but it has issues and has not been updated in 3 years. So, I decided to write my own.

## How it works?
 
This project uses Playwright to open Google Photos in a headless browser. It then starts downloading all the images from the last image to the top. It also downloads images incrementally and sorts them in year and month folders. It also saves the progress in a `.lastdone` file. So, if you stop the download in between, you can start from where you left off.

## Installation

To get started with this project, follow these steps:

### Clone the repository:
```bash
git clone https://github.com/vikas5914/google-photos-backup
```

### Install dependencies:
```bash
npm install
npx playwright install --with-deps chrome
```

### Setup login session:

```bash
node setup.js
```

This will open a Chrome browser and ask you to log in to your Google Photos account. After logging in, either press ctrl+c or close the browser. This will save your login session in the `session` folder.

### Create .lastdone file:

Create a `.lastdone` file in the root of the project. This file stores the starting point of the download.

```bash
touch .lastdone
```

Go to the Google Photos web app, scroll all the way to the bottom, find the last image, open it. Copy the resulting URL and then (you can use any text editor to edit this file):

```bash
echo -e "$URL" > .lastdone
```

### Run the project:

```bash
node index.js
```

Run without headless mode:

```bash
node index.js --headless=false
```

## Bugs

- If an image has no EXIF data, it will be saved in the `download/1970/1` folder.

## Credits
[perkeep/gphotos-cdp](https://github.com/perkeep/gphotos-cdp)

## License
This project is licensed under the MIT License - see the [LICENSE.md](LICENSE.md) file for details.
