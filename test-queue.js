// Script de prueba para el sistema de cola de mensajes
const axios = require('axios');

const BASE_URL = 'http://localhost:3000';

async function testQueue() {
    console.log('🧪 Iniciando pruebas del sistema de cola...\n');

    // Verificar estado inicial de la cola
    try {
        const statusResponse = await axios.get(`${BASE_URL}/estado-cola`);
        console.log('📊 Estado inicial de la cola:', statusResponse.data);
    } catch (error) {
        console.error('❌ Error al verificar estado de la cola:', error.message);
        return;
    }

    // Enviar múltiples mensajes simultáneamente para probar la cola
    const testMessages = [
        { numero: '1234567890', texto: 'Mensaje de prueba 1 - Cola' },
        { numero: '1234567891', texto: 'Mensaje de prueba 2 - Cola' },
        { numero: '1234567892', texto: 'Mensaje de prueba 3 - Cola' },
        { numero: '1234567893', texto: 'Mensaje de prueba 4 - Cola' },
        { numero: '1234567894', texto: 'Mensaje de prueba 5 - Cola' }
    ];

    console.log(`\n📤 Enviando ${testMessages.length} mensajes simultáneamente...\n`);

    const promises = testMessages.map(async (msg, index) => {
        try {
            console.log(`⏳ Enviando mensaje ${index + 1}...`);
            const response = await axios.post(`${BASE_URL}/enviar-mensaje`, msg);
            console.log(`✅ Mensaje ${index + 1} procesado:`, response.data);
            return { success: true, data: response.data };
        } catch (error) {
            console.log(`❌ Mensaje ${index + 1} falló:`, error.response?.data || error.message);
            return { success: false, error: error.response?.data || error.message };
        }
    });

    // Esperar a que todos los mensajes se procesen
    const results = await Promise.all(promises);
    
    console.log('\n📊 Resumen de resultados:');
    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    
    console.log(`✅ Exitosos: ${successful}`);
    console.log(`❌ Fallidos: ${failed}`);

    // Verificar estado final de la cola
    try {
        const finalStatusResponse = await axios.get(`${BASE_URL}/estado-cola`);
        console.log('\n📊 Estado final de la cola:', finalStatusResponse.data);
    } catch (error) {
        console.error('❌ Error al verificar estado final:', error.message);
    }

    console.log('\n🏁 Pruebas completadas');
}

// Función para probar reintentos con un número inválido
async function testRetries() {
    console.log('\n🔄 Probando sistema de reintentos con número inválido...\n');
    
    try {
        const response = await axios.post(`${BASE_URL}/enviar-mensaje`, {
            numero: '0000000000', // Número que probablemente no existe
            texto: 'Mensaje de prueba para reintentos'
        });
        console.log('✅ Respuesta:', response.data);
    } catch (error) {
        console.log('❌ Error esperado:', error.response?.data || error.message);
    }
}

// Ejecutar pruebas
async function runTests() {
    await testQueue();
    await testRetries();
}

// Verificar si axios está disponible
try {
    require('axios');
    runTests().catch(console.error);
} catch (error) {
    console.log('❌ axios no está instalado. Instálalo con: npm install axios');
    console.log('📝 Luego ejecuta: node test-queue.js');
}
