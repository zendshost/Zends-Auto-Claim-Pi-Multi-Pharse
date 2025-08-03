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
function startAllWorkers(config) {
    logToBrowser(`🚀 Memulai proses untuk ${config.senderMnemonics.length} wallet...`);
    
    config.senderMnemonics.forEach((mnemonic, index) => {
        const workerConfig = {
            id: index + 1,
            mnemonic: mnemonic,
            recipientAddress: config.recipientAddress,
            reserveAmount: parseFloat(config.reserveAmount) || 1.01
        };
        runDrainWorker(workerConfig);
    });
}

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

                if (amountToSend > 0) {
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
                } else {
                    const now = Date.now();
                    if (now - lastBalanceLogTime > 1000) {
                        logToBrowser(`${workerId} ⚠️ Saldo tidak cukup (${balance} Pi).`, 'warn');
                        lastBalanceLogTime = now;
                    }
                }
            } catch (e) {
                const errorMessage = e.response?.data?.extras?.result_codes?.transaction || e.message || "Error tidak diketahui";
                logToBrowser(`${workerId} ❌ Error: ${errorMessage}`, 'error');
                await new Promise(resolve => setTimeout(resolve, 5000)); // Jeda 5 detik saat error
                continue; 
            }
            
            // Jeda acak untuk mengurangi beban serentak pada server API
            const randomDelay = Math.floor(Math.random() * 750) + 50; // Jeda 50ms - 800ms
            await new Promise(resolve => setTimeout(resolve, randomDelay));
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
                    startAllWorkers(data.config);
                }
            } else if (data.command === 'stop') {
                if (isRunning) {
                    isRunning = false;
                    logToBrowser("🛑 Perintah STOP diterima. Semua worker akan berhenti...");
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
