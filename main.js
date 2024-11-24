const express = require("express");
const morgan = require("morgan");
const path = require("path");
const fs = require("fs");
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

app.get("/crawl", async (req, res) => {
  let browser;
  const url = "https://www.mapillary.com/app/leaderboard/Vietnam?location=Vietnam&lat=20&lng=0&z=1.5";

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
      await page.waitForSelector("div.pb1.px1.ng-star-inserted", {
        waitUntil: "domcontentloaded",
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

async function retry(fn, retries = 4, delay = 2000) {
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

async function waitForSelectorWithRetry(page, selector, retries = 4, delay = 2000) {
  let attempt = 0;
  while (attempt < retries) {
    try {
      await page.waitForSelector(selector, { visible: true, timeout: 30000 });
      return;
    } catch (err) {
      attempt++;
      console.warn(
        `Attempt ${attempt} failed for selector ${selector}. Retrying in ${delay}ms...`
      );
      if (attempt >= retries) {
        throw new Error(
          `All ${retries} attempts to wait for ${selector} failed.`
        );
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

async function waitForImageLoaded(page, containerSelector, timeout = 10000) {
  try {
    console.log("Waiting for the image to load...");

    await page.waitForFunction(
      (selector) => {
        const element = document.querySelector(selector);
        if (!element) return false;

        const style = window.getComputedStyle(element);
        return (
          style.backgroundImage !== "none" &&
          style.backgroundImage.includes("url(")
        );
      },
      { timeout },
      containerSelector
    );

    console.log("Image loaded successfully.");
    return true;
  } catch (error) {
    console.warn("Image loading timeout or failed.");
    return false;
  }
};

async function trackImageUrls(page, containerSelector, imageUrls, maxDuration = 60000, maxImages = 500) {
  console.log("Starting to track image URLs...");

  const startTime = Date.now();
  let idleTime = 0;

  await page.evaluate((selector) => {
    const targetNode = document.querySelector(selector);
    if (!targetNode) {
      console.warn("Container not found for tracking!");
      return;
    }

    window.collectedImageUrls = window.collectedImageUrls || [];

    const observer = new MutationObserver((mutationsList) => {
      for (const mutation of mutationsList) {
        if (mutation.type === "attributes" && mutation.attributeName === "style") {
          const backgroundImage = window.getComputedStyle(mutation.target).backgroundImage;
          const match = backgroundImage.match(/url\("(.*)"\)/);
          if (match && match[1]) {
            const imageUrl = match[1];
            if (!window.collectedImageUrls.some((item) => item.image === imageUrl)) {
              window.collectedImageUrls.push({ image: imageUrl });
              console.log("New Image URL detected:", imageUrl);
            }
          }
        }
      }
    });

    observer.observe(targetNode, { attributes: true });
    console.log("Observer attached to:", selector);
  }, containerSelector);

  while (Date.now() - startTime < maxDuration) {
    const urls = await page.evaluate(() => window.collectedImageUrls || []);
    const newUrls = urls.filter(
      (item) => !imageUrls.some((existing) => existing.image === item.image)
    );

    if (newUrls.length > 0) {
      for (const newUrl of newUrls) {
        const currentUrl = await page.url();
        const urlObj = new URL(currentUrl);
        const latitude = urlObj.searchParams.get("lat");
        const longitude = urlObj.searchParams.get("lng");

        imageUrls.push({
          Image: newUrl.image,
          Coordinates: {
            Lat: latitude || "Unknown",
            Long: longitude || "Unknown",
          },
        });

        console.log(`New Image with Coordinates: ${newUrl.image}, Lat: ${latitude}, Lng: ${longitude}`);
      }

      const imageLoaded = await waitForImageLoaded(page, containerSelector, 10000);
      if (!imageLoaded) {
        console.warn("Next image did not load. Stopping tracking.");
        break;
      }

      idleTime = 0;

      if (imageUrls.length >= maxImages) {
        console.log(`Reached the maximum image limit (${maxImages}). Stopping.`);
        break;
      }
    } else {
      idleTime += 1000;
      if (idleTime >= 10000) {
        console.log("No new images detected for 10 seconds. Stopping.");
        break;
      }
    }
    await page.waitForTimeout(1000);
  }

  console.log("Finished tracking image URLs.");
};

crawlQueue.process(5, async (job) => {
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
          "--disable-software-rasterizer",
          "--disable-blink-features=AutomationControlled",
          `--proxy-server=${config.proxy.http}`,
        ],
      });

      const context = await browser.newContext({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        proxy: {
          server: config.proxy.http,
          username: config.proxy.username,
          password: config.proxy.password,
        },
        bypassCSP: true,
      });
      const page = await context.newPage();

      await page.goto(userUrl, { waitUntil: "networkidle", timeout: 120000 });
      await randomSleep(1000, 20000);

      await waitForSelectorWithRetry(page, "drawer-sequence-item.ng-star-inserted", 5, 3000);
      const elements = await page.$$("drawer-sequence-item.ng-star-inserted");
      console.log(`Found ${elements.length} leaderboard elements.`);
      if (!elements.length) {
        throw new Error("No user elements found.");
      }
      await randomSleep(100, 500);
      for (const element of elements) {
        try {
          console.log(`Processing element...`);
          const boundingBox = await element.boundingBox();
          const isVisible = !!boundingBox;
          if (!isVisible) {
            console.log("Element is not visible in viewport.");
            await element.evaluate((el) =>
              el.scrollIntoView({ behavior: "smooth", block: "center" })
            );
          }
          await randomSleep(100, 500);
          if (boundingBox) {
            await moveMouseRandomly(page, boundingBox);
          }
          await randomSleep(100, 500);
          await element.click();
          console.log("Waiting...");
          const playButtonSelector = "div.mapillary-sequence-play";
          const containerSelector = "div.mapillary-cover-background";
          await page.waitForSelector(playButtonSelector, { timeout: 35000 });
          const playButton = await page.$(playButtonSelector);
          if (playButton) {
            const isVisible = await playButton.isVisible();
            if (isVisible) {
              console.log("Clicking Play button...");
              await playButton.click();
              const imageLoaded = await waitForImageLoaded(page, containerSelector, 10000);
              if (!imageLoaded) {
                console.warn("First image did not load. Skipping this sequence.");
                return;
              }
            } else {
              console.warn("Play button is not visible.");
            }
          } else {
            console.error("Play button not found!");
            return;
          }
          const imageUrls = [];
          await trackImageUrls(page, containerSelector, imageUrls, 60000, 1000);
          const newUser = new User({
            Username: username,
            Clusters: imageUrls,
          });
          await newUser.save();
        } catch (err) {
          console.error(`Error processing element:`, err.message);
        }
      }
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
  };

  try {
    await retry(crawlData, retries, delay);
    console.log(`Successfully crawled user ${username}`);
  } catch (err) {
    console.error(
      `Failed to crawl user ${username} after retries: ${err.message}`
    );
  }
});

async function clearQueue(queue) {
  try {
    console.log("Clearing the queue...");
    await queue.obliterate({ force: true });
    console.log("Queue cleared successfully!");
  } catch (err) {
    console.error("Error clearing the queue:", err.message);
  }
}

app.get("/clear-queue", async (req, res) => {
  try {
    await clearQueue(crawlQueue);
    res.status(200).send("Queue cleared successfully!");
  } catch (error) {
    console.error("Error clearing the queue:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});