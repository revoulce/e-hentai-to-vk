import { randomBytes } from 'node:crypto';

const appId = process.argv[2];
if (!appId || !/^[1-9]\d*$/.test(appId)) {
  console.error('Использование: npm run vk:auth -- <ID вашего приложения VK с доступом к wall и photos>.');
  process.exitCode = 1;
} else {
  const url = new URL('https://oauth.vk.com/authorize');
  url.search = new URLSearchParams({ client_id: appId, display: 'page', redirect_uri: 'https://oauth.vk.com/blank.html',
    scope: 'photos,wall,offline', response_type: 'token', v: '5.199', state: randomBytes(24).toString('base64url') }).toString();
  console.log('Откройте ссылку в своём браузере и разрешите доступ вашему приложению:');
  console.log(url.href);
  console.log('После авторизации сохраните только access_token из адреса в secrets/vk-token.txt. Не отправляйте адрес или токен в чат.');
  console.log('Этот поток подходит только приложениям VK, которым разрешена соответствующая авторизация и wall.');
  console.log('Если VK отклоняет приложение или права, проверьте его настройки и доступ к API в кабинете VK; токен сообщества не заменяет пользовательский.');
}
