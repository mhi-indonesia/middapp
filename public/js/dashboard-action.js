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