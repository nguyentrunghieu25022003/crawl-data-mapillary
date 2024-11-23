const express = require("express");
const morgan = require("morgan");
const path = require("path");
const fs = require("fs");
const puppeteer = require("puppeteer");
const { chromium } = require("playwright");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const Queue = require("bull");
const os = require("os-utils");
const { Mutex } = require("async-mutex");
const crawlMutex = new Mutex();

require("dotenv").config();

const app = express();
const port = 3000;

const crawlQueue = new Queue("crawlQueue", {
  redis: {
    host: "127.0.0.1",
    port: 6379,
  },
});

const mongodb = require("./database");
mongodb.connect();

const { randomSleep } = require("./randomSleep");
const User = require("./user.model");

setInterval(() => {
  os.cpuUsage((v) => {
    console.log("CPU Usage (%): ", v * 100);
  });
  console.log("Free Memory (GB): ", os.freemem());
}, 5000);

const configPath = path.join(__dirname, "./config.json");
const rawConfig = fs.readFileSync(configPath, "utf-8");
const config = JSON.parse(
  rawConfig.replace(/\$\{(.*?)\}/g, (match, varName) => process.env[varName])
);

app.use(morgan("combined"));
/* puppeteer.use(StealthPlugin()); */

app.get("/crawl", async (req, res) => {
  let browser;
  const url =
    "https://www.mapillary.com/app/leaderboard/Vietnam?location=Vietnam&lat=20&lng=0&z=1.5";

  if (!url) {
    return res.status(400).json({ error: "Please provide a valid URL." });
  }
  let release;
  try {
    release = await crawlMutex.acquire();
    browser = await chromium.launch({
      headless: false,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });

    const allTimeTabSelector = "#tab-All\\ time";

    try {
      console.log("Waiting for All time tab...");
      await page.waitForSelector(allTimeTabSelector, {
        visible: true,
        timeout: 90000,
      });
      await randomSleep(1000, 2000);
      console.log("Clicking All time tab...");
      await page.click(allTimeTabSelector);
      await page.waitForNavigation({
        waitUntil: "networkidle2",
        timeout: 90000,
      });
    } catch (error) {
      console.error("Error interacting with All time tab:", error.message);
    }

    const data = await page.evaluate(() => {
      const elements = Array.from(
        document.querySelectorAll(".flex-auto.h4.truncate")
      );
      return elements.slice(0, 100).map((el) => el.textContent.trim());
    });

    data.forEach(async (username) => {
      await crawlQueue.add({ username });
    });

    res.status(200).json({ success: true });
  } catch (error) {
    console.error("Error during crawling:", error.message);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    if (browser) {
      await browser.close();
    }
    if (release) {
      release();
    }
  }
});

async function retry(fn, retries = 3, delay = 2000) {
  let attempt = 0;
  while (attempt < retries) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      console.warn(`Attempt ${attempt} failed. Retrying in ${delay}ms...`);
      if (attempt >= retries) {
        throw new Error(`All ${retries} attempts failed: ${err.message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
};

async function waitForSelectorWithRetry(page, selector, retries = 3, delay = 2000) {
  let attempt = 0;
  while (attempt < retries) {
    try {
      await page.waitForSelector(selector, { visible: true, timeout: 30000 });
      return;
    } catch (err) {
      attempt++;
      console.warn(`Attempt ${attempt} failed for selector ${selector}. Retrying in ${delay}ms...`);
      if (attempt >= retries) {
        throw new Error(`All ${retries} attempts to wait for ${selector} failed.`);
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
};

async function moveMouseRandomly(page, boundingBox) {
  const x = boundingBox.x + boundingBox.width / 2;
  const y = boundingBox.y + boundingBox.height / 2;
  for (let i = 0; i < 5; i++) {
    const randomX = x + Math.random() * 20 - 10;
    const randomY = y + Math.random() * 20 - 10;
    await page.mouse.move(randomX, randomY, { steps: 5 });
    await randomSleep(200, 500);
  }
  console.log("Mouse moved over the element.");
};

crawlQueue.process(async (job) => {
  const release = await crawlMutex.acquire();
  const { username } = job.data;
  console.log(`Processing crawl for user: ${username}`);
  const userUrl = `https://www.mapillary.com/app/user/${username}`;
  const retries = 5;
  const delay = 3000;
  
  const crawlData = async () => {
    let browser;
    if (browser) {
      await browser.close();
    }
    try {
      browser = await chromium.launch({
        headless: false,
        args: [
          "--disable-setuid-sandbox",
          "--no-sandbox",
        ],
      });
  
      const context = await browser.newContext({
        proxy: {
          server: config.proxy.http,
          username: config.proxy.username,
          password: config.proxy.password,
        },
      });
      const page = await context.newPage();

      await page.goto(userUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      await randomSleep(1000, 25000);
      
      await page.waitForSelector("drawer-sequence-item.ng-star-inserted", { visible: true, timeout: 60000 });
      const elements = await page.$$("drawer-sequence-item.ng-star-inserted");
      console.log(`Found ${elements.length} leaderboard elements.`);
      if (!elements.length) {
        throw new Error("No user elements found.");
      }
      await randomSleep(500, 1000);
  
      const imageUrls = [];
      for (const element of elements) {
        try {
          const tmp = {
            Image: "",
            Coordinates: {
              Lat: "",
              Long: "",
            },
          };
          console.log(`Processing element...`);
          const boundingBox = await element.boundingBox();
          const isVisible = !!boundingBox;
          if (!isVisible) {
            console.log("Element is not visible in viewport.");
            await element.evaluate((el) => el.scrollIntoView({ behavior: "smooth", block: "center" }));
          }
          await randomSleep(500, 1000);
          if (boundingBox) {
            await moveMouseRandomly(page, boundingBox);
          }
          await randomSleep(500, 1000);
          await element.click();
          console.log("Waiting...");
          await randomSleep(500, 1000);
          console.log(`Found drawer...`);
          await waitForSelectorWithRetry(page, "div.mapillary-cover-background", 5, 3000)
          const imgElement = await page.$("div.mapillary-cover-background");
          const currentUrl = await page.url();
          const urlObj = new URL(currentUrl);
          const latitude = urlObj.searchParams.get("lat");
          const longitude = urlObj.searchParams.get("lng");
          if (imgElement) {
            const imageUrl = await page.evaluate((element) => {
              const style = element.style.backgroundImage;
              const match = style.match(/url\("(.*)"\)/);
              return match ? match[1] : null;
            }, imgElement);
            console.log("Image url", imageUrl);
            if (latitude && longitude && imageUrl) {
              tmp.Image = imageUrl;
              tmp.Coordinates.Long = longitude;
              tmp.Coordinates.Lat = latitude;
            } else {
              console.warn("Skipping incomplete data:", { latitude, longitude, imageUrl });
            }
          }
          imageUrls.push(tmp);
          await page.waitForSelector("div.mapillary-sequence-step-next", { visible: true, timeout: 90000 });
          const nextElement = await page.$("div.mapillary-sequence-step-next");
          console.log("Next...");
          if (nextElement) {
            let nextClickLimit = 5;
            while (nextElement && nextClickLimit > 0) {
              await nextElement.click();
              nextClickLimit--;
              await randomSleep(1000, 2000);
            }
            if (nextClickLimit === 0) {
              console.log("Reached max next clicks limit.");
            }
          } else {
            console.log("No next element, waiting...");
          }
        } catch (err) {
          console.error(`Error processing element:`, err.message);
        }
      }
      const newUser = new User({
        Username: username,
        Clusters: imageUrls,
      });
      await newUser.save();
      console.log("Crawl finished !");
    } catch (error) {
      console.error(`Error crawling user ${username}:`, error.message);
      throw error;
    } finally {
      if (browser) {
        await browser.close();
      }
      release();
    }
  }

  try {
    await retry(crawlData, retries, delay);
    console.log(`Successfully crawled user ${username}`);
  } catch (err) {
    console.error(`Failed to crawl user ${username} after retries: ${err.message}`);
  }
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
