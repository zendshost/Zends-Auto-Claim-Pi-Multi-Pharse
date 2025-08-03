// Import Modul
const express = require('express');
const http = require('http');
const path = require('path');
const { Server: WebSocketServer } = require('ws');
const StellarSdk = require('stellar-sdk');
const ed25519 = require('ed25519-hd-key');
const bip39 = require('bip39');
require("dotenv").config();

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

// --- State Global ---
let isRunning = false;
let clientWs = null;

// --- Fungsi Helper ---
const logToBrowser = (message, level = 'info') => {
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

// --- Logika Inti Bot ---

/**
 * Master controller yang memulai worker untuk setiap mnemonic.
 * @param {object} config - Konfigurasi dari UI.
 */
function startAllWorkers(config) {
    logToBrowser(`🚀 Memulai proses untuk ${config.senderMnemonics.length} wallet...`);
    
    config.senderMnemonics.forEach((mnemonic, index) => {
        const workerConfig = {
            id: index + 1,
            mnemonic: mnemonic,
            recipientAddress: config.recipientAddress,
            reserveAmount: parseFloat(config.reserveAmount) || 1.01
        };
        // Jalankan setiap worker secara paralel. Jangan `await` di sini.
        runDrainWorker(workerConfig);
    });
}

/**
 * Worker yang menangani logika drain untuk SATU wallet.
 * @param {object} workerConfig - Konfigurasi spesifik untuk worker ini.
 */
async function runDrainWorker(workerConfig) {
    const workerId = `[Wallet #${workerConfig.id}]`;
    
    try {
        const piServer = new StellarSdk.Server('https://apimainnet.vercel.app');
        const senderKeypair = await getKeypairFromMnemonic(workerConfig.mnemonic);
        const senderPublic = senderKeypair.publicKey();

        logToBrowser(`${workerId} 🔑 Pengirim: ${senderPublic.substring(0, 10)}...`);

        let lastBalanceLogTime = 0;

        while (isRunning) {
            try {
                const account = await piServer.loadAccount(senderPublic);
                const piBalance = account.balances.find(b => b.asset_type === 'native');
                const balance = parseFloat(piBalance.balance);

                const amountToSend = balance - workerConfig.reserveAmount;

                if (amountToSend <= 0) {
                    const now = Date.now();
                    if (now - lastBalanceLogTime > 1) { // Kurangi spam log saat saldo kosong
                        logToBrowser(`${workerId} ⚠️ Saldo tidak cukup (${balance} Pi).`, 'warn');
                        lastBalanceLogTime = now;
                    }
                    await new Promise(resolve => setTimeout(resolve, 1)); // Jeda sangat singkat untuk efisiensi
                    continue;
                }

                const formattedAmount = amountToSend.toFixed(7);
                logToBrowser(`${workerId} ➡️  Saldo Terdeteksi! Mengirim ${formattedAmount} Pi...`, 'success');

                const tx = new StellarSdk.TransactionBuilder(account, {
                    fee: await piServer.fetchBaseFee(),
                    networkPassphrase: 'Pi Network',
                })
                .addOperation(StellarSdk.Operation.payment({
                    destination: workerConfig.recipientAddress,
                    asset: StellarSdk.Asset.native(),
                    amount: formattedAmount,
                }))
                .setTimeout(30)
                .build();

                tx.sign(senderKeypair);
                const result = await piServer.submitTransaction(tx);
                logToBrowser(`${workerId} ✅ Transaksi Terkirim! Hash: ${result.hash.substring(0, 15)}...`);

            } catch (e) {
                const errorMessage = e.response?.data?.extras?.result_codes?.transaction || e.message || "Error tidak diketahui";
                logToBrowser(`${workerId} ❌ Error: ${errorMessage}`, 'error');
                await new Promise(resolve => setTimeout(resolve, 3000)); // Jeda lebih lama saat ada error
            }
        }
    } catch (initError) {
        logToBrowser(`${workerId} ❌ Gagal Inisialisasi: ${initError.message}`, 'error');
    }
}

// --- Manajemen Koneksi WebSocket ---
wss.on('connection', (ws) => {
    logToBrowser('🖥️ Client terhubung.');
    clientWs = ws;
    ws.send(JSON.stringify({ type: 'status', running: isRunning }));

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.command === 'start') {
                if (!isRunning) {
                    isRunning = true;
                    startAllWorkers(data.config); // Panggil master controller
                }
            } else if (data.command === 'stop') {
                if (isRunning) {
                    isRunning = false; // Set flag untuk menghentikan semua loop
                    logToBrowser("🛑 Perintah STOP diterima. Semua worker akan berhenti setelah operasi saat ini selesai.");
                    // Kirim status kembali ke UI agar tombol menjadi aktif lagi
                    ws.send(JSON.stringify({ type: 'status', running: false }));
                }
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
