// public/js/dashboard-actions.js

async function reSync(orderId, event) {
    if (!confirm('Apakah Anda ingin mencoba sinkronisasi ulang ke Ginee?')) return;

    // Ambil elemen tombol yang diklik (menggunakan event)
    const btn = event.currentTarget;
    const originalText = btn.innerHTML;
    
    // UI Feedback
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Syncing...';

    try {
        const response = await fetch(`/sync-order/${orderId}`, { 
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        const result = await response.json();

        if (result.success) {
            alert('Sukses: ' + result.message);
            window.location.reload(); 
        } else {
            alert('Gagal: ' + result.message);
        }
    } catch (err) {
        console.error('Error:', err);
        alert('Terjadi kesalahan jaringan atau server');
    } finally {
        btn.disabled = false;
        btn.innerHTML = originalText;
    }
}

// function showErrorLog(logId) {
//     const errorData = document.getElementById('error-data-' + logId).textContent;
//     // Mencoba parse jika data berupa string JSON, jika tidak tampilkan apa adanya
//     try {
//         const parsed = JSON.parse(JSON.parse(errorData)); // Double parse jika tersimpan sebagai stringified JSON
//         document.getElementById('errorContent').textContent = JSON.stringify(parsed, null, 4);
//     } catch (e) {
//         document.getElementById('errorContent').textContent = errorData;
//     }
                
//     const modal = new bootstrap.Modal(document.getElementById('errorModal'));
//     modal.show();
// }

function showErrorLog(logId) {
    const dataElement = document.getElementById('error-data-' + logId);
    
    // Proteksi jika elemen tidak ditemukan
    if (!dataElement) {
        console.error("Elemen dengan ID error-data-" + logId + " tidak ditemukan!");
        alert("Data error tidak ditemukan di halaman ini.");
        return;
    }

    const errorData = dataElement.textContent;
    const displayElement = document.getElementById('errorContent');

    if (!displayElement) {
        alert("Elemen modal 'errorContent' tidak ditemukan!");
        return;
    }

    try {
        let parsed = JSON.parse(errorData);
        if (typeof parsed === 'string') parsed = JSON.parse(parsed);
        displayElement.textContent = JSON.stringify(parsed, null, 4);
    } catch (e) {
        displayElement.textContent = errorData;
    }
                
    const modal = new bootstrap.Modal(document.getElementById('errorModal'));
    modal.show();
}