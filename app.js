require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const axios = require('axios');
const path = require('path');
const app = express();

// cPanel secara otomatis memberikan PORT, jika tidak ada pakai 3000
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Mengatur folder 'public' sebagai penyedia file statis
app.use(express.static(path.join(__dirname, 'public')));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Konfigurasi Database MySQL (Sesuaikan dengan cPanel Anda)
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER,      
    password: process.env.DB_PASSWORD,  
    database: process.env.DB_NAME,      
    port: process.env.DB_PORT || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ==========================================
// FUNGSI KIRIM KE GINEE DENGAN RETRY
// ==========================================
async function kirimKeGineeDenganRetry(orderData, maxAttempts = 3) {
    let attempt = 0;
    while (attempt < maxAttempts) {
        attempt++;
        try {
            const response = await axios.post(`http://localhost:${PORT}/simulasi-ginee-api`, {
                order_id: orderData.orderID,
                amount: orderData.amount
            }, { timeout: 10000 });
            return { success: true, message: response.data.message };
        } catch (error) {
            const errorMsg = error.response ? JSON.stringify(error.response.data) : error.message;
            if (attempt >= maxAttempts) return { success: false, message: errorMsg };
            await sleep(2000);
        }
    }
}

// =========================================
// RUTE HALAMAN UTAMA REDIRECT
// =========================================
// Jika ada yang akses domain utama akan langsung diarahkan ke dashboard

app.get('/', async (req, res) => {
    res.redirect('/dashboard');
})

// ==========================================
// DASHBOARD ROUTE (FIXED VERSION)
// ==========================================
app.get('/dashboard', async (req, res) => {
    try {
        const tab = req.query.tab || 'orders';
        const status = req.query.status || '';
        const page = parseInt(req.query.page) || 1;
        const limit = 5;
        const offset = (page - 1) * limit;

        // 1. Errors_log (Riwayat Sinkronisasi)
        const [syncLogs] = await pool.query(`
            SELECT e.*, o.grab_order_id 
            FROM errors_log e
            JOIN orders o ON e.order_id = o.id
            ORDER BY e.created_at DESC 
            LIMIT 20
        `);

        // 2. Ambil Statistik
        const [statsRows] = await pool.query(`
            SELECT 
                COUNT(*) as total,
                SUM(CASE WHEN status_sync = 'SUCCESS' THEN 1 ELSE 0 END) as sukses,
                SUM(CASE WHEN status_sync = 'FAILED' THEN 1 ELSE 0 END) as gagal
            FROM orders
        `);

        let dataRows = [];
        let totalCount = 0;

        // 3. Logika Tab dengan JOIN dan FIX LIMIT OFFSET
        if (tab === 'orders') {
            let filterSql = "";
            let params = [];
            if (status) {
                filterSql = "WHERE o.status_sync = ?";
                params.push(status);
            }
            
            const query = `
                SELECT o.*, u.customer_name, u.phone_number
                FROM orders o 
                LEFT JOIN users u ON o.id = u.order_id
                ${filterSql} 
                ORDER BY o.created_at DESC 
                LIMIT ${limit} OFFSET ${offset}`; // Menggunakan template literal untuk angka
            
            [dataRows] = await pool.query(query, params);

            for (let order of dataRows) {
                const [items] = await pool.query("SELECT * FROM order_items WHERE order_id = ?", [order.id]);
                order.barang = items; 
            }

            const [countRes] = await pool.query(`SELECT COUNT(*) as cnt FROM orders o ${filterSql}`, params);
            totalCount = countRes[0].cnt;

        } else if (tab === 'users') {
            // JOIN ke tabel orders untuk ambil grab_order_id
            [dataRows] = await pool.query(`
                SELECT u.*, o.grab_order_id 
                FROM users u
                JOIN orders o ON u.order_id = o.id
                ORDER BY u.id DESC 
                LIMIT ${limit} OFFSET ${offset}
            `);
            const [countRes] = await pool.query(`SELECT COUNT(*) as cnt FROM users`);
            totalCount = countRes[0].cnt;

        } else if (tab === 'items') {
            // JOIN ke tabel orders untuk ambil grab_order_id
            [dataRows] = await pool.query(`
                SELECT oi.*, o.grab_order_id 
                FROM order_items oi
                JOIN orders o ON oi.order_id = o.id
                ORDER BY oi.id DESC 
                LIMIT ${limit} OFFSET ${offset}
            `);
            const [countRes] = await pool.query(`SELECT COUNT(*) as cnt FROM order_items`);
            totalCount = countRes[0].cnt;
        }

        res.render('dashboard.ejs', { 
            stats: statsRows[0] || {total:0, sukses:0, gagal:0}, 
            data: dataRows,
            currentPage: page,
            totalPages: Math.ceil(totalCount / limit) || 1,
            currentTab: tab,
            currentStatus: status,
            syncLogs: syncLogs
        });
    } catch (err) {
        console.error(err);
        res.status(500).send("Dashboard Error: " + err.message);
    }
});

// ==========================================
// WEBHOOK ENDPOINT
// ==========================================
app.post('/webhook/grab', async (req, res) => {
    const grabData = req.body;
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        // 1. Cek apakah Order ID ini sudah pernah masuk sebelumnya
        const [existingOrder] = await conn.query(
            "SELECT id, payment_status FROM orders WHERE grab_order_id = ?", 
            [grabData.orderID]
        );

        let orderId;

        if (existingOrder.length > 0) {
            // JIKA SUDAH ADA: Update saja status payment-nya
            orderId = existingOrder[0].id;
            await conn.query(
                "UPDATE orders SET payment_status = ?, raw_grab_data = ? WHERE id = ?",
                [grabData.status || 'PENDING', JSON.stringify(grabData), orderId]
            );
            console.log(`Order ${grabData.orderID} diupdate ke status: ${grabData.status}`);
        } else {

            // 1. Amankan data mentah ke grab_raw di awal
            await conn.query(
                `INSERT INTO grab_raw (grab_order_id, payload) VALUES (?, ?)`,
                [grabData.orderID, JSON.stringify(grabData)]
            );

            // 2. Insert Order
            const [orderRes] = await conn.query(
                `INSERT INTO orders (grab_order_id, total_amount, payment_status, raw_grab_data) VALUES (?, ?, ?, ?)`,
                [grabData.orderID, grabData.amount, grabData.status || 'PAID', JSON.stringify(grabData)]
            );
            const newID = orderRes.insertId;

            // 3. Insert Items
            for (let item of grabData.items) {
                await conn.query(
                    `INSERT INTO order_items (order_id, product_name, quantity, sale_price, regular_price) VALUES (?, ?, ?, ?, ?)`,
                    [newID, item.name, item.qty, item.price, item.price]
                );
            }

            // 4. Insert User
            await conn.query(
                `INSERT INTO users (order_id, customer_name, phone_number, customer_email) VALUES (?, ?, ?, ?)`,
                [newID, grabData.customer.name, grabData.customer.phone, grabData.customer.email]
            );
        }

        await conn.commit();
        res.status(200).send('OK');

        // Background Sync ke Ginee
        // Asumsikan kita hanya sinkron ke Ginee jika status dari Grab adalah 'PAID'
        if (grabData.status === 'PAID') {
            
            // Jalankan Background Sync ke Ginee
            const gineeResult = await kirimKeGineeDenganRetry(grabData);
            
            if (gineeResult.success) {
                // Update status di tabel orders
                await pool.query("UPDATE orders SET status_sync = 'SUCCESS' WHERE id = ?", [newID]);

                // Catat log sukses
                await pool.query(
                    `INSERT INTO errors_log (order_id, status_sync, status_code, error_message) 
                    VALUES (?, ?, ?, ?)`,
                    [newID, 'SUCCESS', 200, 'Sinkronisasi Berhasil']
                );
            } else {
                // Update status gagal
                await pool.query("UPDATE orders SET status_sync = 'FAILED' WHERE id = ?", [newID]);
                
                // Catat log gagal beserta raw response-nya
                await pool.query(
                    `INSERT INTO errors_log (order_id, status_sync, status_code, error_message, raw_response) 
                    VALUES (?, ?, ?, ?, ?)`,
                    [newID, 'FAILED', 500, 'Gagal Sinkron Ginee', gineeResult.message]
                );
            }
            
        } else {
            // Jika status bukan PAID (misal PENDING atau CANCELLED)
            console.log(`Order ${grabData.orderID} tidak disinkron karena status: ${grabData.status}`);
            
            // Opsional: Catat di log bahwa ini ditunda
            await pool.query(
                `INSERT INTO errors_log (order_id, status_sync, status_code, error_message) 
                VALUES (?, ?, ?, ?)`,
                [newID, 'SKIPPED', 202, `Sinkronisasi ditunda (Status: ${grabData.status})`]
            );
        }
    } catch (err) {
        await conn.rollback();
        console.error(err);
        if (err.code === 'ER_DUP_ENTRY') return res.status(200).send('Duplicate');
        res.status(500).send('Error Database: ' + err.message);
    } finally {
        conn.release();
    }
});

// ==========================================
// ROUTE SINKRONISASI MANUAL
// ==========================================
app.post('/sync-order/:id', async (req, res) => {
    try {
        const orderId = req.params.id;

        // 1. Ambil data order dan raw_grab_data dari DB
        const [orders] = await pool.query("SELECT * FROM orders WHERE id = ?", [orderId]);
        
        if (orders.length === 0) return res.status(404).json({ success: false, message: "Order tidak ditemukan" });

        const orderData = orders[0];

        // Validasi
        if (orderData.payment_status !== 'PAID') {
            return res.status(400).json({ 
                success: false, 
                message: "Gagal: Pesanan belum dibayar (Status: " + orderData.payment_status + ")" 
            });
        }

        const grabData = JSON.parse(orderData.raw_grab_data);

        // 2. Jalankan fungsi retry ke Ginee
        const gineeResult = await kirimKeGineeDenganRetry(grabData);

        if (gineeResult.success) {
            await pool.query("UPDATE orders SET status_sync = 'SUCCESS' WHERE id = ?", [orderId]);
            await pool.query(
                `INSERT INTO errors_log (order_id, status_sync, status_code, error_message) VALUES (?, 'SUCCESS', 200, 'Resync Manual Berhasil')`,
                [orderId]
            );
            res.json({ success: true, message: "Sinkronisasi Berhasil!" });
        } else {
            await pool.query("UPDATE orders SET status_sync = 'FAILED' WHERE id = ?", [orderId]);
            await pool.query(
                `INSERT INTO errors_log (order_id, status_sync, status_code, error_message, raw_response) VALUES (?, 'FAILED', 500, 'Resync Manual Gagal', ?)`,
                [orderId, gineeResult.message]
            );
            res.status(500).json({ success: false, message: "Gagal: " + gineeResult.message });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/simulasi-ginee-api', (req, res) => {
    res.status(200).json({ message: "Sukses terhubung ke Ginee" });
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));