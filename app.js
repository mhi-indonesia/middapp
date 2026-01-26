require('dotenv').config(); // Opsional jika ingin pakai .env
const express = require('express');
const mysql = require('mysql2/promise');
const axios = require('axios');
const path = require('path');
const app = express();

// cPanel secara otomatis memberikan PORT, jika tidak ada pakai 3000
const PORT = process.env.PORT || 3000;

app.use(express.json());
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
            }, { timeout: 5000 });
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
// DASHBOARD ROUTE (MySQL VERSION)
// ==========================================
app.get('/dashboard', async (req, res) => {
    try {
        const tab = req.query.tab || 'orders';
        const status = req.query.status || '';
        const page = parseInt(req.query.page) || 1;
        const limit = 5;
        const offset = (page - 1) * limit;

        // 1. Ambil Statistik (MySQL CASE WHEN)
        const [statsRows] = await pool.query(`
            SELECT 
                COUNT(*) as total,
                SUM(CASE WHEN status_sync = 'SUCCESS' THEN 1 ELSE 0 END) as sukses,
                SUM(CASE WHEN status_sync = 'FAILED' THEN 1 ELSE 0 END) as gagal
            FROM orders
        `);

        let dataRows = [];
        let totalCount = 0;

        if (tab === 'orders') {
            let filterSql = "";
            let params = [];
            if (status) {
                filterSql = "WHERE o.status_sync = ?";
                params.push(status);
            }
            
            // MySQL tidak punya json_agg sekuat Postgres, kita ambil data user saja dulu
            // Item barang akan diproses di sisi EJS atau via sub-query sederhana
            const query = `
                SELECT o.*, u.customer_name, u.phone_number
                FROM orders o 
                LEFT JOIN users u ON o.id = u.order_id
                ${filterSql} ORDER BY o.created_at DESC LIMIT ? OFFSET ?`;
            
            [dataRows] = await pool.query(query, [...params, limit, offset]);

            // Ambil items untuk setiap order secara manual (MySQL kompatibilitas)
            for (let order of dataRows) {
                const [items] = await pool.query("SELECT * FROM order_items WHERE order_id = ?", [order.id]);
                order.barang = items; 
            }

            const [countRes] = await pool.query(`SELECT COUNT(*) as cnt FROM orders o ${filterSql}`, params);
            totalCount = countRes[0].cnt;

        } else if (tab === 'users') {
            [dataRows] = await pool.query(`SELECT * FROM users ORDER BY id DESC LIMIT ? OFFSET ?`, [limit, offset]);
            const [countRes] = await pool.query(`SELECT COUNT(*) as cnt FROM users`);
            totalCount = countRes[0].cnt;
        } else {
            [dataRows] = await pool.query(`SELECT * FROM order_items ORDER BY id DESC LIMIT ? OFFSET ?`, [limit, offset]);
            const [countRes] = await pool.query(`SELECT COUNT(*) as cnt FROM order_items`);
            totalCount = countRes[0].cnt;
        }

        res.render('dashboard.ejs', { 
            stats: statsRows[0] || {total:0, sukses:0, gagal:0}, 
            data: dataRows,
            currentPage: page,
            totalPages: Math.ceil(totalCount / limit) || 1,
            currentTab: tab,
            currentStatus: status
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

        // 1. Insert Order
        const [orderRes] = await conn.query(
            `INSERT INTO orders (grab_order_id, total_amount, raw_grab_data) VALUES (?, ?, ?)`,
            [grabData.orderID, grabData.amount, JSON.stringify(grabData)]
        );
        const newID = orderRes.insertId;

        // 2. Insert Items
        for (let item of grabData.items) {
            await conn.query(
                `INSERT INTO order_items (order_id, product_name, quantity, sale_price, regular_price) VALUES (?, ?, ?, ?, ?)`,
                [newID, item.name, item.qty, item.price, item.price]
            );
        }

        // 3. Insert User
        await conn.query(
            `INSERT INTO users (order_id, customer_name, phone_number, customer_email) VALUES (?, ?, ?, ?)`,
            [newID, grabData.customer.name, grabData.customer.phone, grabData.customer.email]
        );

        await conn.commit();
        res.status(200).send('OK');

        // Background Sync ke Ginee
        const gineeResult = await kirimKeGineeDenganRetry(grabData);
        if (gineeResult.success) {
            await pool.query("UPDATE orders SET status_sync = 'SUCCESS' WHERE id = ?", [newID]);
        } else {
            await pool.query("UPDATE orders SET status_sync = 'FAILED' WHERE id = ?", [newID]);
            // Pastikan tabel errors_log ada jika ingin mencatat log error
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

app.post('/simulasi-ginee-api', (req, res) => {
    res.status(200).json({ message: "Sukses terhubung ke Ginee" });
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));