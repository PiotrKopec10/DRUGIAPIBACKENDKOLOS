const express = require('express');
const { MongoClient } = require('mongodb');
const fs = require('fs');
const swaggerUi = require('swagger-ui-express');

const app = express();
const port = 3000;

// Dodaj middleware do obsługi analizy ciała żądania w formacie JSON
app.use(express.json());

const mongoUrl = 'mongodb://localhost:27017';
const dbName = 'warehouseDB';
const collectionName = 'products';

const client = new MongoClient(mongoUrl, { useNewUrlParser: true, useUnifiedTopology: true });

client.connect()
    .then(async () => {
        console.log('Połączono z bazą danych');

        const db = client.db(dbName);

        const collection = db.collection(collectionName);

        const count = await collection.countDocuments();
        if (count === 0) {
            const data = fs.readFileSync('products.json', 'utf8');
            const productsData = JSON.parse(data);
            productsData.forEach((product, index) => {
                product.id = index + 1;
            });

            const result = await collection.insertMany(productsData);

            console.log(`${result.insertedCount} produktów dodanych do kolekcji.`);
        } else {
            console.log('Kolekcja już zawiera produkty, pomijam dodawanie.');
        }

        const swaggerDocument = require('./swagger-definition.json');

        app.use('/swag', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

        app.get('/products', async (req, res) => {
            try {
                const { name, minPrice, maxPrice, minQuantity, maxQuantity, sortBy } = req.query;

                const filter = {};
                if (name) {
                    filter.name = { $regex: new RegExp(name, 'i') };
                }
                if (minPrice) {
                    filter.price = { $gte: parseFloat(minPrice) };
                }
                if (maxPrice) {
                    filter.price = { ...filter.price, $lte: parseFloat(maxPrice) };
                }
                if (minQuantity) {
                    filter.quantity = { $gte: parseInt(minQuantity) };
                }
                if (maxQuantity) {
                    filter.quantity = { ...filter.quantity, $lte: parseInt(maxQuantity) };
                }

                let sortOption = {};
                if (sortBy) {
                    sortOption = { [sortBy === 'id' ? '_id' : sortBy]: 1 };
                } else {
                    sortOption = { name: 1 };
                }

                const products = await collection.find(filter).sort(sortOption).toArray();

                const formattedProducts = products.map(({ _id, ...rest }) => {
                    return { id: _id.toString(), ...rest };
                });

                res.json(formattedProducts);
            } catch (error) {
                console.error('Błąd podczas pobierania produktów:', error);
                res.status(500).send('Błąd serwera');
            }
        });

        app.post('/products', async (req, res) => {
            try {
                if (!req.body) {
                    return res.status(400).json({ error: 'Brak danych wejściowych.' });
                }

                const { name, price, description, quantity, unit } = req.body;

                if (!name || !price || !description || !quantity || !unit) {
                    return res.status(400).json({ error: 'Nieprawidłowe dane wejściowe. Wszystkie pola są wymagane.' });
                }

                const existingProduct = await collection.findOne({ name });

                if (existingProduct) {
                    return res.status(400).json({ error: 'Produkt o podanej nazwie już istnieje.' });
                }

                const lastUsedId = await collection.find().sort({ id: -1 }).limit(1).toArray();
                const newId = (lastUsedId.length > 0) ? lastUsedId[0].id + 1 : 1;

                const result = await collection.insertOne({
                    id: newId,
                    name,
                    price: parseFloat(price),
                    description,
                    quantity: parseInt(quantity),
                    unit,
                });

                console.log(`Dodano nowy produkt: ${name}`);
                res.status(201).json({ message: 'Produkt dodany pomyślnie.' });
            } catch (error) {
                console.error('Błąd podczas dodawania produktu:', error);
                res.status(500).send('Błąd serwera');
            }
        });

        app.put('/products/:id', async (req, res) => {
            try {
                const productId = req.params.id;
                const { name, price, description, quantity, unit } = req.body;

                const existingProduct = await collection.findOne({ id: parseInt(productId) });

                if (!existingProduct) {
                    return res.status(404).json({ error: 'Produkt o podanym identyfikatorze nie istnieje.' });
                }

                const updateResult = await collection.updateOne(
                    { id: parseInt(productId) },
                    {
                        $set: {
                            name: name || existingProduct.name,
                            price: parseFloat(price) || existingProduct.price,
                            description: description || existingProduct.description,
                            quantity: parseInt(quantity) || existingProduct.quantity,
                            unit: unit || existingProduct.unit,
                        },
                    }
                );

                if (updateResult.modifiedCount > 0) {
                    console.log(`Zaktualizowano produkt o identyfikatorze ${productId}`);
                    res.json({ message: 'Produkt zaktualizowany pomyślnie.' });
                } else {
                    console.log(`Nie dokonano zmian w produkcie o identyfikatorze ${productId}`);
                    res.json({ message: 'Brak zmian w produkcie.' });
                }
            } catch (error) {
                console.error('Błąd podczas aktualizacji produktu:', error);
                res.status(500).send('Błąd serwera');
            }
        });


        app.delete('/products/:id', async (req, res) => {
            try {
                const productId = req.params.id;

                const existingProduct = await db.collection('products').findOne({ id: parseInt(productId) });

                if (!existingProduct) {
                    return res.status(404).json({ error: 'Produkt o podanym identyfikatorze nie istnieje.' });
                }

                if (existingProduct.quantity === 0) {
                    return res.status(400).json({ error: 'Produkt nie jest dostępny w magazynie do usunięcia.' });
                }

                const deleteResult = await db.collection('products').deleteOne({ id: parseInt(productId) });

                if (deleteResult.deletedCount > 0) {
                    console.log(`Usunięto produkt o identyfikatorze ${productId}`);
                    res.json({ message: 'Produkt usunięty pomyślnie.' });
                } else {
                    console.log(`Nie usunięto produktu o identyfikatorze ${productId}`);
                    res.status(500).json({ error: 'Błąd podczas usuwania produktu.' });
                }
            } catch (error) {
                console.error('Błąd podczas usuwania produktu:', error);
                res.status(500).send('Błąd serwera');
            }
        });


        app.get('/inventory-report', async (req, res) => {
            try {
                const pipeline = [
                    {
                        $group: {
                            _id: null,
                            totalProducts: { $sum: 1 },
                            totalQuantity: { $sum: "$quantity" },
                            totalValue: { $sum: { $multiply: ["$price", "$quantity"] } }
                        }
                    }
                ];

                const report = await collection.aggregate(pipeline).toArray();

                if (report.length === 0) {
                    return res.status(404).json({ error: 'Brak danych do wygenerowania raportu.' });
                }

                res.json({
                    totalProducts: report[0].totalProducts,
                    totalQuantity: report[0].totalQuantity,
                    totalValue: report[0].totalValue
                });
            } catch (error) {
                console.error('Błąd podczas generowania raportu:', error);
                res.status(500).send('Błąd serwera');
            }
        });

        app.listen(port, () => {
            console.log(`Serwer Express działa na http://localhost:${port}`);
        });
    })
    .catch(err => {
        console.error('Błąd połączenia z bazą danych:', err);
    });
