# Установка серверного ядра

Это инструкция для подготовленного ядра; реальные публикации VK пока заблокированы. Проверки фактического Ubuntu, архитектуры, DNS и существующих сервисов выполняются при развёртывании на сервере пользователя.

## Разработка на Linux

Установите Node.js 24.21.0 и npm, затем в корне репозитория:

```sh
npm ci
mkdir -p secrets
# Создайте один раз; не перезаписывайте существующий секрет.
node -e "require('node:fs').writeFileSync('secrets/api-token.txt', require('node:crypto').randomBytes(32).toString('base64url'), {mode:0o600,flag:'wx'})"
API_TOKEN_FILE="$PWD/secrets/api-token.txt" npm run dev
```

Команды воспроизводимой проверки: `npm run check`. Для запуска скомпилированного приложения: `npm run build`, затем `API_TOKEN_FILE="$PWD/secrets/api-token.txt" npm start`.

## Docker Compose

Dockerfile использует многоэтапную сборку и пользователя `node`. Образ Node закреплён версией. Приложение использует один volume `/app/data`, лимит 1 ГиБ памяти и 1 CPU; значения требуют измерения на целевом сервере. Поддерживаются только **один контейнер и один процесс** на volume — не увеличивайте количество реплик.

```sh
mkdir -p secrets
node -e "require('node:fs').writeFileSync('secrets/api-token.txt', require('node:crypto').randomBytes(32).toString('base64url'), {mode:0o600,flag:'wx'})"
cp deploy/.env.example deploy/.env
# В Linux контейнер запускается с UID 1000; секрет должен читаться этим UID.
sudo chown 1000:1000 secrets/api-token.txt
chmod 600 secrets/api-token.txt
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --build app
curl --fail http://127.0.0.1:3000/ehvk/health/ready
```

Если Node на сервере не установлен, создайте секрет `openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n' > secrets/api-token.txt` и назначьте права, как выше. Это альтернатива команде Node для первого создания секрета.

Секрет не входит в образ, `.env` и Git. Compose монтирует файл в `/run/secrets/api_token`. Bearer-токен перечитывается на каждом запросе, поэтому для обычной замены содержимого файла пересборка не нужна; при замене самого файла с изменением inode пересоздайте контейнер, чтобы обновить bind mount.

Для существующего обратного прокси проксируйте `/ehvk/` на `127.0.0.1:3000` **без удаления префикса**. Остальные маршруты домена не меняйте. Не открывайте 3000 наружу.

Если отдельный Caddy подходит существующей конфигурации сервера, укажите DNS A/AAAA `revoulce.ftp.sh`, проверьте свободные 80/443 и запустите:

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml --profile https up -d --build
```

`deploy/Caddyfile.example` обслуживает только `/ehvk/*`. Для уже используемого домена включите этот обработчик в существующую конфигурацию; отдельный контейнер Caddy не запускайте на занятых портах. Выпуск TLS не проверен на текущем окружении.

Публичные лимиты можно изменить в `deploy/.env`; токены там хранить нельзя. Расписание и модель изменяются через API и сохраняются в SQLite. Стандартные сроки файлов: черновики — 24 часа бездействия, завершённые пары — 72 часа, отменённые — 24 часа. Активная очередь не удаляется по возрасту.

Готовность HTTP/SQLite не означает готовность VK. Адаптер включается после настройки пользовательского токена и проверок по [vk.md](vk.md). До этого `/status` возвращает конкретную причину блокировки; для работы очереди нужны `vk.verified: true` и `vk.state: ready`. При Docker-запуске с VK добавьте `-f deploy/compose.vk.yaml` к основному Compose-файлу.
