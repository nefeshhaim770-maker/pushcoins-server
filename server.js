// פונקציה בשרת שיוצרת טוקן בלבד (ללא חיוב) לפי המבנה שביקשת
app.post('/generate-token', async (req, res) => {
    const { userId, ccNum, ccExp } = req.body;
    try {
        const response = await axios.post('https://kesherhk.info/ConnectToKesher/ConnectToKesher', {
            Json: {
                userName: '2181420WS2087',
                password: 'WVmO1iterNb33AbWLzMjJEyVnEQbskSZqyel5T61Hb5qdwR0gl',
                func: "GetToken",
                creditNum: ccNum,
                validity: ccExp,
                // שליחת מזהה הלקוח כפי שנדרש בתיעוד
                customerRef: userId 
            },
            format: "json"
        });

        const resData = response.data;
        // חילוץ הטוקן מהתגובה כפי שמופיע בתיעוד
        if (resData.Token) {
            await User.findByIdAndUpdate(userId, { 
                token: resData.Token,
                lastExpiry: ccExp,
                lastCardDigits: ccNum.slice(-4)
            });
            res.json({ success: true, token: resData.Token });
        } else {
            res.status(400).json({ success: false, error: "לא התקבל טוקן" });
        }
    } catch (e) {
        res.status(500).json({ success: false, error: "שגיאת חיבור" });
    }
});
