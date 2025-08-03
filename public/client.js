document.addEventListener('DOMContentLoaded', () => {
    // Elemen UI
    const startButton = document.getElementById('startButton');
    const stopButton = document.getElementById('stopButton');
    const logConsole = document.getElementById('log-console');
    
    // Input Konfigurasi
    const senderMnemonicsInput = document.getElementById('senderMnemonics');
    const recipientAddressInput = document.getElementById('recipientAddress');
    const reserveAmountInput = document.getElementById('reserveAmount');

    let ws;

    function connectWebSocket() {
        const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
        ws = new WebSocket(`${protocol}://${window.location.host}`);

        ws.onopen = () => addLog('✅ Terhubung ke server.', 'success');
        ws.onmessage = handleServerMessage;
        ws.onclose = () => {
            addLog('🔌 Koneksi terputus. Mencoba menghubungkan kembali...', 'error');
            updateUIState(false);
            setTimeout(connectWebSocket, 5000);
        };
        ws.onerror = () => addLog('❌ WebSocket error.', 'error');
    }

    function handleServerMessage(event) {
        const data = JSON.parse(event.data);
        if (data.type === 'log') {
            addLog(data.message, data.level);
        } else if (data.type === 'status') {
            updateUIState(data.running);
        }
    }

    function addLog(message, level = 'info') {
        const entry = document.createElement('div');
        entry.className = `log-entry log-${level}`;
        entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
        logConsole.appendChild(entry);
        logConsole.parentElement.scrollTop = logConsole.parentElement.scrollHeight;
    }

    function updateUIState(isRunning) {
        startButton.disabled = isRunning;
        stopButton.disabled = !isRunning;
        senderMnemonicsInput.disabled = isRunning;
        recipientAddressInput.disabled = isRunning;
        reserveAmountInput.disabled = isRunning;
    }

    startButton.addEventListener('click', () => {
        // Ambil mnemonics dari textarea, pisahkan per baris, dan bersihkan
        const mnemonicsArray = senderMnemonicsInput.value
            .split('\n')
            .map(m => m.trim())
            .filter(m => m.length > 0);

        const config = {
            senderMnemonics: mnemonicsArray, // Kirim sebagai array
            recipientAddress: recipientAddressInput.value.trim(),
            reserveAmount: reserveAmountInput.value.trim()
        };

        // Validasi input
        if (config.senderMnemonics.length === 0 || !config.recipientAddress) {
            addLog("❌ Harap isi setidaknya satu Mnemonic Pengirim dan Alamat Penerima.", 'error');
            return;
        }
        if (parseFloat(config.reserveAmount) < 1) {
            addLog("❌ Jumlah saldo sisa minimal harus 1.0", 'error');
            return;
        }

        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ command: 'start', config }));
            updateUIState(true);
            addLog(`▶️ Perintah START dikirim untuk ${config.senderMnemonics.length} wallet.`, 'warn');
        }
    });

    stopButton.addEventListener('click', () => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ command: 'stop' }));
            addLog('⏹️ Perintah STOP dikirim. Semua bot akan berhenti...', 'warn');
        }
    });

    connectWebSocket();
});
