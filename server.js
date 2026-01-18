app.post('/donate', async (req, res) => {
    const { userId, amount, ccDetails, fullName, tz, useToken, phone, email, note } = req.body;
    try {
        let user = await User.findById(userId);
        if (!user) return res.status(404).json({ error: "User not found" });

        // בניית אובייקט הטרנזקציה לפי דוגמת ה-CURL
        let tranData = {
            Total: parseFloat(amount),
            Currency: 1, 
            CreditType: 1, 
            Phone: phone || user.phone || "0500000000",
            FirstName: (fullName || user.name || "שם").split(" ")[0],
            LastName: (fullName || user.name || "משפחה").split(" ").slice(1).join(" ") || "משפחה",
            Mail: email || user.email || "no-email@test.com", 
            ParamJ: "J4", 
            TransactionType: "debit",
            ProjectNumber: "00001"
        };

        if (useToken && user.token) {
            console.log("💳 שימוש באסימון שנשמר:", user.token);
            // בחיוב טוקן, חלק מהמסופים דורשים לשלוח רק את הטוקן ללא CreditNum
            tranData.Token = user.token; 
        } else if (ccDetails) {
            console.log("💳 שימוש בפרטי כרטיס אשראי חדשים");
            tranData.CreditNum = ccDetails.num; 
            tranData.Expiry = ccDetails.exp; 
            tranData.Cvv2 = ccDetails.cvv;
        }

        const response = await axios.post('https://kesherhk.info/ConnectToKesher/ConnectToKesher', {
            Json: { 
                userName: '2181420WS2087', 
                password: 'WVmO1iterNb33AbWLzMjJEyVnEQbskSZqyel5T61Hb5qdwR0gl', 
                func: "SendTransaction", 
                format: "json", 
                tran: tranData 
            },
            format: "json"
        });

        // חילוץ התגובה
        const resData = response.data.RequestResult ? response.data : { RequestResult: response.data };
        console.log("📩 תגובה מלאה מחברת הסליקה:", JSON.stringify(resData));

        if (resData.RequestResult?.Status === true) {
            user.totalDonated += parseFloat(amount);
            
            // עדכון טוקן אם הוחזר אחד חדש
            const rToken = resData.Token || resData.RequestResult?.Token || (resData.Data ? JSON.parse(resData.Data).Token : null);
            if (rToken) {
                console.log("🔑 התקבל אסימון חדש:", rToken);
                user.token = rToken;
                if (!useToken && ccDetails) user.lastCardDigits = ccDetails.num.slice(-4);
            }
            
            await user.save();
            res.json({ success: true, user });
        } else {
            const errorMsg = resData.RequestResult?.Description || "העסקה נדחתה";
            console.log("❌ דחייה:", errorMsg);
            res.status(400).json({ success: false, error: errorMsg });
        }
    } catch (e) {
        console.error("❌ שגיאה בביצוע תרומה:", e.message);
        res.status(500).json({ success: false, error: "שגיאת תקשורת עם שרת הסליקה" });
    }
});
