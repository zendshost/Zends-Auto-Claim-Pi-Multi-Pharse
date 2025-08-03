// Import Modul
const express = require('express');
const http = require('http');
const path = require('path');
const { Server: WebSocketServer } = require('ws');
const StellarSdk = require('stellar-sdk');
const ed25519 = require('ed25519-hd-key');
const bip39 = require('bip39');
require("dotenv").config();

// --- Konfigurasi & Inisialisasi ---
const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

let isRunning = false;
let currentConfig = {};
let clientWs = null;

const logToBrowser = (message, level = 'info') => {
    // console.log(message); // Uncomment for server-side debugging
    if (clientWs && clientWs.readyState === clientWs.OPEN) {
        clientWs.send(JSON.stringify({ type: 'log', level, message }));
    }
};

async function getKeypairFromMnemonic(mnemonic) {
    if (!bip39.validateMnemonic(mnemonic)) {
        throw new Error("Mnemonic tidak valid.");
    }
    const seed = await bip39.mnemonicToSeed(mnemonic);
    const derivationPath = "m/44'/314159'/0'";
    const { key } = ed25519.derivePath(derivationPath, seed.toString('hex'));
    return StellarSdk.Keypair.fromRawEd25519Seed(key);
}

// --- Logika Utama "Auto-Drain" ---
async function runSenderLogic(config) {
    if (!isRunning) return;

    logToBrowser("🚀 Memulai inisialisasi bot auto-drain...");

    try {
        const piServer = new StellarSdk.Server('https://apimainnet.vercel.app');
        const senderKeypair = await getKeypairFromMnemonic(config.senderMnemonic);
        const senderPublic = senderKeypair.publicKey();
        const reserveAmount = parseFloat(config.reserveAmount) || 1.01; // Default 1.01 jika tidak valid

        logToBrowser(`🔑 Alamat Pengirim: ${senderPublic}`);
        logToBrowser(`🎯 Alamat Penerima: ${config.recipientAddress}`);
        logToBrowser(`💰 Saldo Disisakan: ${reserveAmount} Pi`);
        logToBrowser("✅ Inisialisasi selesai. Memulai loop pemeriksaan saldo...");
        logToBrowser("======================================================");

        let lastBalanceLogTime = 0;

        while (isRunning) {
            try {
                const account = await piServer.loadAccount(senderPublic);
                const piBalance = account.balances.find(b => b.asset_type === 'native');
                const balance = parseFloat(piBalance.balance);

                const amountToSend = balance - reserveAmount;

                if (amountToSend <= 0) {
                    const now = Date.now();
                    if (now - lastBalanceLogTime > 1) { // Log status hanya sekali per 1 ms
                        logToBrowser(`⚠️ Saldo tidak cukup (${balance} Pi). Memeriksa tanpa henti...`, 'warn');
                        lastBalanceLogTime = now;
                    }
                    continue; // Loop tanpa jeda
                }

                const formattedAmount = amountToSend.toFixed(7);
                logToBrowser(`➡️  Saldo Terdeteksi! Mengirim ${formattedAmount} Pi...`, 'success');

                const tx = new StellarSdk.TransactionBuilder(account, {
                    fee: await piServer.fetchBaseFee(),
                    networkPassphrase: 'Pi Network',
                })
                .addOperation(StellarSdk.Operation.payment({
                    destination: config.recipientAddress,
                    asset: StellarSdk.Asset.native(),
                    amount: formattedAmount,
                }))
                .setTimeout(30)
                .build();

                tx.sign(senderKeypair);
                const result = await piServer.submitTransaction(tx);

                logToBrowser(`✅ Transaksi Terkirim! Hash: ${result.hash}`);
                logToBrowser(`🔗 Link: https://blockexplorer.minepi.com/mainnet/transactions/${result.hash}`);
                logToBrowser("------------------------------------------------------");

            } catch (e) {
                const errorMessage = e.response?.data?.extras?.result_codes?.transaction || e.message || "Error tidak diketahui";
                logToBrowser(`❌ Terjadi Error: ${errorMessage}`, 'error');
                await new Promise(resolve => setTimeout(resolve, 10)); // Jeda 10 ms saat ada error
            }
        }
    } catch (initError) {
        logToBrowser(`❌ Gagal Inisialisasi: ${initError.message}`, 'error');
    }

    logToBrowser("🛑 Proses dihentikan.");
    if (clientWs) clientWs.send(JSON.stringify({ type: 'status', running: false }));
    isRunning = false;
}

// --- Manajemen Koneksi WebSocket ---
wss.on('connection', (ws) => {
    logToBrowser('🖥️ Server terhubung.');
    clientWs = ws;
    ws.send(JSON.stringify({ type: 'status', running: isRunning }));

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.command === 'start') {
                if (!isRunning) {
                    isRunning = true;
                    currentConfig = data.config; // Simpan konfigurasi dari UI
                    runSenderLogic(currentConfig); // Jalankan bot dengan konfigurasi tersebut
                }
            } else if (data.command === 'stop') {
                isRunning = false;
            }
        } catch (e) {
            logToBrowser(`Error memproses pesan client: ${e.message}`, 'error');
        }
    });

    ws.on('close', () => {
        logToBrowser('🔌 Client terputus.');
        if (clientWs === ws) clientWs = null;
    });
});

server.listen(PORT, () => {
    console.log(`🚀 Server berjalan di http://localhost:${PORT}`);
});
