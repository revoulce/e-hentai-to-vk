import { loadConfig } from './config.js';
import { VkPublisher } from './vk-publisher.js';

async function main() {
  const config = loadConfig({ ...process.env, API_TOKEN_FILE: process.env.API_TOKEN_FILE ?? 'secrets/api-token.txt' });
  if (!config.vk) {
    console.error('Укажите VK_TOKEN_FILE в .env. Порядок подключения: docs/vk.md.');
    process.exitCode = 1; return;
  }
  const publisher = new VkPublisher(config.vk);
  await publisher.check();
  console.log(JSON.stringify(publisher.status(), null, 2));
  process.exitCode = publisher.available() ? 0 : 1;
}
main().catch(() => { console.error('Не удалось проверить VK. Проверьте настройки .env по docs/vk.md.'); process.exitCode = 1; });
