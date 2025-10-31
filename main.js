import { default as axios } from "axios";
import * as cheerio from "cheerio";
import https from "https";
import fs from "fs";
import TelegramBot from "node-telegram-bot-api";
import nodeCron from "node-cron";
import dotenv from "dotenv";
import puppeteer from "puppeteer";
dotenv.config();

const SEARCH_TEXT = process.env.SEARCH_TEXT;
const TARGET_QUEUES = process.env.TARGET_QUEUES.split(",");

const STORAGE_FILE = process.env.STORAGE_FILE;
const SUBSCRIBER_FILE = process.env.SUBSCRIBER_FILE;
const token = process.env.TOKEN;

const bot = new TelegramBot(token, { polling: true });

function getSubscribers() {
  try {
    if (fs.existsSync(SUBSCRIBER_FILE)) {
      const data = fs.readFileSync(SUBSCRIBER_FILE, "utf8");
      return JSON.parse(data);
    }
  } catch (error) {
    console.error("Ошибка чтения файла подписчиков:", error.message);
  }
  return [];
}

function addSubscriber(chatId) {
  const subscribers = getSubscribers();
  if (!subscribers.includes(chatId)) {
    subscribers.push(chatId);
    try {
      fs.writeFileSync(
        SUBSCRIBER_FILE,
        JSON.stringify(subscribers, null, 2),
        "utf8",
      );
      console.log(`Новый подписчик добавлен: ${chatId}`);
    } catch (error) {
      console.error("Ошибка сохранения файла подписчиков:", error.message);
    }
  }
}
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  addSubscriber(chatId); // Добавляем пользователя в наш список

  // Отправляем приветственное сообщение
  bot.sendMessage(
    chatId,
    "Вітаю! Ви підписались на оновлення ГПВ. Я повідомлю вас, коли текст на сторінці зміниться.",
  );
});
const makeGetRequest = async (url) => {
  let browser = null;
  try {
    // Запускаем браузер
    browser = await puppeteer.launch({
      headless: true,
      // 'args' важны для запуска на серверах Linux (VPS/VDS)
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();

    // Устанавливаем User-Agent, как у реального браузера (это все еще важно)
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36",
    );

    console.log(`Перехожу на ${url}...`);

    // Переходим на страницу и ждем, пока сеть успокоится (JS выполнится)
    // Увеличиваем таймаут до 30 секунд, т.к. Puppeteer медленнее
    await page.goto(url, {
      waitUntil: "domcontentloaded", // Ждем только HTML (быстро)
      timeout: 60000, // Даем 60 секунд на всякий случай
    });
    console.log("Страница загружена, получаю HTML...");

    // Получаем полный HTML-контент страницы ПОСЛЕ выполнения JavaScript
    const htmlData = await page.content();

    return htmlData;
  } catch (error) {
    console.error("Ошибка при выполнении Puppeteer:", error);
    throw error;
  } finally {
    await browser.close();
  }
  // const proxyHost = "38.54.71.67";
  // const proxyPort = 80; // <-- ВАМ НУЖНО НАЙТИ ПРАВИЛЬНЫЙ ПОРТ!
  // const headers = {
  //   "User-Agent":
  //     "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36",
  // };
  // const agent = new https.Agent({
  //   rejectUnauthorized: false,
  // });

  // const responce = await axios.get(url, {
  //   // headers,
  //   // httpsAgent: agent,
  //   proxy: {
  //     protocol: "http",
  //     host: proxyHost,
  //     port: proxyPort,
  //     // auth: {
  //     //   username: "myuser", // <-- нужен логин
  //     //   password: "GAz!R,6NSUHsQA$e", // <-- нужен пароль
  //     // },
  //   },
  // });
  // return responce.data;
};
const processPage = async (data) => {
  const $ = cheerio.load(data);
  let updateTimestampLine = null;
  $("p").each((index, element) => {
    const pText = $(element).text().trim();
    if (pText.includes(SEARCH_TEXT)) {
      updateTimestampLine = pText;
      return false;
    }
  });

  if (!updateTimestampLine) {
    console.log(`Не найден текст триггера "${SEARCH_TEXT}".`);
    return;
  }

  let oldContent = "";
  if (fs.existsSync(STORAGE_FILE)) {
    oldContent = fs.readFileSync(STORAGE_FILE, "utf8");
  }

  if (oldContent === updateTimestampLine) {
    console.log("No changes detected.");
    return;
  }

  console.log("Content has changed!");
  console.log("Old:", oldContent);
  console.log("New:", updateTimestampLine);

  let foundSchedules = [];
  let count = 0;
  $("p").each((index, element) => {
    if (count >= 2) {
      return;
    }
    const pText = $(element).text().trim();
    for (const queuePrefix of TARGET_QUEUES) {
      if (pText.startsWith(queuePrefix)) {
        foundSchedules.push(pText);
        break;
      }
    }
    if (pText.includes(SEARCH_TEXT) && count >= 0) {
      console.log("Found search text:", pText);
      count++;
    }
    console.log("Processed paragraph:", pText, count);
  });
  let notificationContent;
  const header = `🔔 **ОНОВЛЕННЯ ГРАФІКІВ!** 🔔\n\n${updateTimestampLine}`;

  if (foundSchedules.length === 0) {
    notificationContent = `${header}\n\n**Важливо:** Оновлення було, але розклад для черг ${TARGET_QUEUES.join(", ")} не знайдено на сторінці.`;
  } else {
    notificationContent = `${header}\n\n**Знайдено розклад для ваших черг:**\n${foundSchedules.join("\n")}`;
  }
  await sendNotification(notificationContent);

  fs.writeFileSync(STORAGE_FILE, updateTimestampLine, "utf8");
};
async function sendNotification(messageContent) {
  console.log("ОБНАРУЖЕНО ИЗМЕНЕНИЕ! Начинаю рассылку...", messageContent);

  const subscribers = getSubscribers();
  if (subscribers.length === 0) {
    console.log("Нет подписчиков для отправки.");
    return;
  }

  console.log(`Отправка уведомлений ${subscribers.length} пользователям...`);

  for (const chatId of subscribers) {
    try {
      await bot.sendMessage(chatId, messageContent, { parse_mode: "Markdown" });
      console.log(`Успешно отправлено ${chatId}`);
    } catch (error) {
      console.error(`Ошибка отправки ${chatId}: ${error}`);
    }
  }
}

const main = async () => {
  try {
    const responce = await makeGetRequest(
      encodeURI("https://www.zoe.com.ua/графіки-погодинних-стабілізаційних"),
    );

    await processPage(responce);
  } catch (e) {
    console.error(e);
  }
};

nodeCron.schedule("*/10 * * * *", () => {
  main();
});

main();
