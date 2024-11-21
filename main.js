const express = require("express");
const morgan = require("morgan");
const path = require("path");
const fs = require("fs");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const Queue = require("bull");
const os = require("os-utils");
const { Semaphore } = require("async-mutex");

const MAX_TABS = 10;
const tabSemaphore = new Semaphore(MAX_TABS);

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
puppeteer.use(StealthPlugin());

app.post("/start-crawl", async (req, res) => {
  try {
    const job = await crawlQueue.add();
    res.status(200).json({ message: "Crawl job added to queue", jobId: job.id });
  } catch (err) {
    console.error("Error adding job to queue", err);
    res.status(500).json({ message: "Failed to add job to queue" });
  }
});

app.delete("/job/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const job = await crawlQueue.getJob(id);
    if (!job) {
      return res.status(404).json({ message: "Job not found" });
    }

    await job.remove();
    res.status(200).json({ message: `Job ${id} removed successfully` });
  } catch (error) {
    console.error("Error removing job:", error);
    res.status(500).json({ message: "Error removing job" });
  }
});

let browser = null;

async function getBrowserInstance() {
  if (!browser || !browser.isConnected()) {
    console.log("Launching a new browser instance...");
    browser = await puppeteer.launch({
      headless: false,
      args: [
        "--disable-setuid-sandbox",
        "--no-sandbox",
        "--single-process",
        "--no-zygote",
        "--enable-gpu",
        "--window-size=1920,1080",
        `--proxy-server=${config.proxy.http}`,
        "--disable-web-security",
        "--disable-features=IsolateOrigins,site-per-process",
      ],
      executablePath: puppeteer.executablePath(),
      ignoreHTTPSErrors: true,
      bypassCSP: true,
    });
  }
  return browser;
};

async function getPage() {
  await tabSemaphore.acquire();
  const browser = await getBrowserInstance();
  try {
    const page = await browser.newPage();
    page.on("close", () => tabSemaphore.release());
    page.setDefaultTimeout(60000);
    return page;
  } catch (err) {
    tabSemaphore.release();
    throw err;
  }
}

async function retryWrapper(taskFunc, retries = 5) {
  let attempts = 0;
  while (attempts < retries) {
    try {
      return await taskFunc();
    } catch (err) {
      attempts++;
      console.error(`Attempt ${attempts} failed: ${err.message}`);
      if (err.message.includes("Session closed")) {
        console.error("Session closed. Restarting browser...");
        if (!browser || !browser.isConnected()) {
          await getBrowserInstance();
        }
        continue;
      }
      if (attempts >= retries) {
        console.error("Max retry attempts reached. Throwing error.");
        throw err;
      }
      const delay = attempts * 1000;
      console.log(`Retrying in ${delay / 1000}s...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
};

crawlQueue.process(10, async (job) => {
  console.log("Starting crawl job...");
  try {
    const user = {
      Username: "",
      Clusters: [],
    };

    const page = await getPage();

    const isOnline = await page.evaluate(() => navigator.onLine);
    console.log("Network status:", isOnline ? "Online" : "Offline");

    if (config.proxy.username && config.proxy.password) {
      await page.authenticate({
        username: config.proxy.username,
        password: config.proxy.password,
      });
      console.log("Authenticated successfully !");
    }

    await page.setRequestInterception(true);
    page.on("request", (request) => {
    const resourceType = request.resourceType();
      if (["stylesheet", "font", "media"].includes(resourceType)) {
        console.log(`Blocking resource: ${resourceType}`);
        request.abort();
      } else {
        request.continue();
      }
    });

    const url = "https://www.mapillary.com/app/leaderboard/Vietnam?location=Vietnam&lat=20&lng=0&z=1.5";
    await retryWrapper(() => page.goto(url, { waitUntil: "networkidle2", timeout: 90000 }));
    
    const allTimeTabSelector = "#tab-All\\ time";

    try {
      console.log("Waiting for All time tab...");
      await retryWrapper(() => page.waitForSelector(allTimeTabSelector, { visible: true, timeout: 90000 }));
      await randomSleep(1000, 2000);
      console.log("Clicking All time tab...");
      await retryWrapper(() => page.click(allTimeTabSelector));
      await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 90000 });     
    } catch (error) {
      console.error("Error interacting with All time tab:", error.message);
    }

    const elements = await page.$$("div.pb1.px1.ng-star-inserted");
    console.log(`Found ${elements.length} leaderboard elements.`);
    if (!elements.length) {
      throw new Error("No user elements found.");
    }

    await Promise.all(
      elements.slice(0, 100).map(async (element) => {
        try {
          console.log(`Processing element ${index + 1}/${Math.min(elements.length, 100)}...`);
          await retryWrapper(() => element.click());
          console.log("Waiting for drawer elements...");
          await page.waitForSelector("drawer-sequence-item.ng-star-inserted", { timeout: 90000 });
          const drawers = await page.$$("drawer-sequence-item.ng-star-inserted");
          console.log(`Found ${drawers.length} drawers.`);
          for (const drawer of drawers) {
            console.log(`Processing drawer...`);
            const isVisible = await drawer.isIntersectingViewport();
            if (!isVisible) {
              console.log("Element not visible, skipping...");
              continue;
            }
            await retryWrapper(() => drawer.click());
            console.log("Evaluating number of items...");
            const numberOfItems = await page.evaluate(() => {
              const item = document.querySelector(
                "div.bg-gray.white.border-radius-4.flex.items-center.ng-star-inserted"
              );
              return item ? parseInt(item.textContent.trim(), 10) : 0;
            });
            console.log(`Found ${numberOfItems} items.`);
            if (numberOfItems > 0) {
              const currentUrl = await page.url();
              const urlObj = new URL(currentUrl);
              const latitude = urlObj.searchParams.get("lat");
              const longitude = urlObj.searchParams.get("lng");
              console.log(`Fetching image URLs for drawer...`);
              const imageUrls = await page.evaluate(() => {
                const images = Array.from(document.querySelectorAll("div.mapillary-cover-background"));
                return images.map((img) =>
                  img.style.backgroundImage.match(/url\("(.*)"\)/)?.[1]
                ).filter(Boolean);
              });
              console.log(`Found ${imageUrls.length} image URLs.`);
              if(imageUrls.length > 0) {
                imageUrls.forEach((imageUrl) => {
                  user.Clusters.push({
                    Image: imageUrl,
                    Coordinates: {
                      Lat: latitude,
                      Long: longitude,
                    },
                  });
                });
              }
            }
          }
        } catch (err) {
          console.error(`Error processing element:`, err.message);
        }
      })
    );
    console.log("Saving user data to database...");
    const newUser = new User(user);
    await newUser.save();
    console.log("Crawl job completed!");
  } catch (err) {
    console.error("Error during crawl job", err.message);
  } finally {
    if (page && !page.isClosed()) {
      await page.close();
    }
    tabSemaphore.release();
    console.log("Tab closed.");
  }
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});