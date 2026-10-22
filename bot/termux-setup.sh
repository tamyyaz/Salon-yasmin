#!/data/data/com.termux/files/usr/bin/bash
# Android tablet/phone (Termux from F-Droid, NOT the Play Store version). One-time setup:
#   pkg install -y git && git clone https://github.com/tamyyaz/Salon-yasmin.git && bash Salon-yasmin/bot/termux-setup.sh
set -e
pkg update -y
pkg install -y nodejs-lts git termux-api
cd "$(dirname "$0")"
npm install
mkdir -p ~/.termux/boot
cat > ~/.termux/boot/salon-bot.sh <<BOOT
#!/data/data/com.termux/files/usr/bin/sh
# runs at boot (needs the Termux:Boot app); keeps the CPU awake and restarts the assistant if it stops
termux-wake-lock
cd "$(pwd)"
while true; do node index.js; sleep 10; done
BOOT
chmod +x ~/.termux/boot/salon-bot.sh
[ -f .env ] || cp .env.example .env
echo
echo "Done. Next: edit bot/.env (nano .env), put service-account.json next to index.js, then:  termux-wake-lock && npm start"
