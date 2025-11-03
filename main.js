import { default as axios } from "axios";
import * as cheerio from "cheerio";
import https from "https";
import fs from "fs";
import TelegramBot from "node-telegram-bot-api";
import nodeCron from "node-cron";
import dotenv from "dotenv";
dotenv.config();

// const TARGET_QUEUES = process.env.TARGET_QUEUES.split(",");

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
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36",
  };
  const agent = new https.Agent({
    rejectUnauthorized: false,
  });

  const responce = await axios.get(url, { headers, httpsAgent: agent });
  return responce.data;
};

const processPage = async (data) => {
  const $ = cheerio.load(data);

  const TARGET_QUEUES = [
    "1.1",
    "1.2",
    "2.1",
    "2.2",
    "3.1",
    "3.2",
    "4.1",
    "4.2",
    "5.1",
    "5.2",
    "6.1",
    "6.2",
  ];

  let foundMessage = ""; // This will store the text from the <p> tag

  $("p").each((index, element) => {
    if (foundMessage) {
      return false; // Stop the loop once we find a match
    }

    const pText = $(element).text();
    const includesAll = TARGET_QUEUES.every((queue) => pText.includes(queue));

    if (includesAll) {
      foundMessage = pText; // Save the text
    }
  });

  if (!foundMessage) {
    console.log(`Не найден <p> тег, который содержит все очереди.`);
    return;
  }

  const newContentForCheck = foundMessage;
  const fullHeadingText = foundMessage;
  let oldContent = "";
  if (fs.existsSync(STORAGE_FILE)) {
    oldContent = fs.readFileSync(STORAGE_FILE, "utf8");
  }

  if (oldContent === newContentForCheck) {
    console.log("No changes detected.");
    return;
  }

  console.log("Content has changed!");

  const notificationContent = newContentForCheck;

  // Make sure sendNotification is defined and imported
  console.log("Pretending to send notification:", notificationContent);
  sendNotification(notificationContent);
  fs.writeFileSync(STORAGE_FILE, newContentForCheck, "utf8");
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
