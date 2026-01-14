const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

const pool = new Pool({ 
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

app.get('/api/jogos', async (req, res) => {
    try {
        // Buscando os próximos 30 jogos (Aumentamos o volume)
        const resp = await axios.get('https://v3.football.api-sports.io/fixtures?next=30', {
            headers: { 
                'x-rapidapi-key': process.env.API_FOOTBALL_KEY,
                'x-rapidapi-host': 'v3.football.api-sports.io'
            }
        });

        const jogos = resp.data.response.map(j => ({
            id: j.fixture.id,
            liga: j.league.name,
            pais: j.league.country,
            // Adicionando fotos e horários
            home: { name: j.teams.home.name, logo: j.teams.home.logo },
            away: { name: j.teams.away.name, logo: j.teams.away.logo },
            data: j.fixture.date, // Formato ISO para o JS tratar no front
            odds: { 
                casa: (1.4 + Math.random() * 2).toFixed(2), 
                empate: (3.1 + Math.random() * 1).toFixed(2), 
                fora: (2.2 + Math.random() * 4).toFixed(2) 
            }
        }));
        
        res.json(jogos);
    } catch (error) {
        console.error("Erro API:", error.message);
        res.json([{
            liga: "ERRO DE CONEXÃO", home: {name: "Verifique", logo: ""}, away: {name: "Sua Chave API", logo: ""}, data: new Date(), odds: {casa: "0.00", empate: "0.00", fora: "0.00"}
        }]);
    }
});

// Registrar Bilhete
app.post('/api/finalizar', async (req, res) => {
    const { valor, palpite, times, odd } = req.body;
    const codigo = Math.random().toString(36).substring(2, 8).toUpperCase();
    const retorno = (valor * odd).toFixed(2);
    try {
        await pool.query('INSERT INTO bilhetes (codigo, valor, retorno, times, palpite) VALUES ($1, $2, $3, $4, $5)', [codigo, valor, retorno, times, palpite]);
    } catch (e) { console.log("Erro banco"); }
    res.json({ codigo, retorno });
});

app.listen(process.env.PORT || 3000);
