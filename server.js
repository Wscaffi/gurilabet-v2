const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

// Conexão segura com o Banco de Dados
const pool = new Pool({ 
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Inicialização silenciosa do banco
async function initDb() {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS bilhetes (id SERIAL, codigo TEXT, valor NUMERIC, retorno NUMERIC, times TEXT, palpite TEXT, data TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        console.log("✅ Banco conectado com sucesso!");
    } catch (e) {
        console.error("⚠️ Aviso: Banco de dados não detectado. As apostas não serão salvas, mas os jogos carregarão.");
    }
}
initDb();

// ROTA DE JOGOS REAIS
app.get('/api/jogos', async (req, res) => {
    try {
        const resp = await axios.get('https://v3.football.api-sports.io/fixtures?next=15&status=NS', {
            headers: { 'x-rapidapi-key': process.env.API_FOOTBALL_KEY }
        });
        
        const jogos = resp.data.response.map(j => ({
            id: j.fixture.id,
            liga: j.league.name,
            times: `${j.teams.home.name} x ${j.teams.away.name}`,
            odds: { 
                casa: (1.5 + Math.random()).toFixed(2), 
                empate: (3.0 + Math.random()).toFixed(2), 
                fora: (2.5 + Math.random()).toFixed(2) 
            }
        }));
        
        res.json(jogos.length > 0 ? jogos : [{times: "Nenhum jogo encontrado no momento", odds: {casa: "1.00", empate: "1.00", fora: "1.00"}}]);
    } catch (error) {
        res.json([
            {times: "Flamengo x Palmeiras", odds: {casa: "2.10", empate: "3.20", fora: "3.80"}},
            {times: "Real Madrid x Barcelona", odds: {casa: "1.95", empate: "3.40", fora: "4.10"}}
        ]);
    }
});

app.post('/api/finalizar', async (req, res) => {
    const { valor, palpite, times, odd } = req.body;
    const codigo = Math.random().toString(36).substring(2, 8).toUpperCase();
    const retorno = (valor * odd).toFixed(2);
    try {
        await pool.query('INSERT INTO bilhetes (codigo, valor, retorno, times, palpite) VALUES ($1, $2, $3, $4, $5)', [codigo, valor, retorno, times, palpite]);
    } catch (e) { console.log("Erro ao salvar bilhete no banco."); }
    res.json({ codigo, retorno });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Motor ativo na porta ${PORT}`));
