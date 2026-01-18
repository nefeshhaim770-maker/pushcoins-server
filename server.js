app.post('/donate', async (req, res) => {
    const { userId, amount, ccDetails, fullName, tz, useToken, phone, email, note } = req.body;
    try {
        let user = await User.findById(userId);
        if (!user) return res.status(404).json({ success: false, error: "משתמש לא נמצא" });

        let tranData = {
            Total: parseFloat(amount),
            Currency: 1, CreditType: 10, NumPayment: "12",
            Phone: phone || user.phone || "0500000000",
            FirstName: (fullName || user.name || "שם").split(" ")[0],
            LastName: (fullName || user.name || "משפחה").split(" ").slice(1).join(" ") || "משפחה",
            Mail: email || user.email || "no-email@test.com",
            ParamJ: "J4", TransactionType: "debit", ProjectNumber: "00001",
            customerRef: user._id.toString() // חובה לפי התיעוד
        };

        if (useToken && user.token) {
            tranData.Token = user.token;
            tranData.Expiry = user.lastExpiry; // שליחת תוקף חובה בחיוב חוזר
        } else if (ccDetails) {
            tranData.CreditNum = ccDetails.num;
            tranData.Expiry = ccDetails.exp;
            tranData.Cvv2 = ccDetails.cvv;
        }

        const response = await axios.post('https://kesherhk.info/ConnectToKesher/ConnectToKesher', {
            Json: { userName: '2181420WS2087', password: 'WVmO1iterNb33AbWLzMjJEyVnEQbskSZqyel5T61Hb5qdwR0gl', func: "SendTransaction", format: "json", tran: tranData },
            format: "json"
        });

        const resData = response.data;
        console.log("📩 Kesher Full Response:", JSON.stringify(resData)); // הדפסה ללוג לצורך ניפוי שגיאות

        if (resData.RequestResult?.Status === true || resData.Status === true) {
            user.totalDonated += parseFloat(amount);
            user.donationsHistory.push({ amount: parseFloat(amount), note: note || "", date: new Date() });
            
            const rToken = resData.Token || resData.RequestResult?.Token;
            if (rToken) {
                user.token = rToken;
                if (!useToken && ccDetails) {
                    user.lastCardDigits = ccDetails.num.slice(-4);
                    user.lastExpiry = ccDetails.exp;
                }
            }
            await user.save();
            res.json({ success: true, user });
        } else {
            // טיפול משופר בשגיאות למניעת undefined
            const errorMsg = resData.RequestResult?.Description || resData.Description || resData.ErrorMessage || "העסקה נדחתה על ידי חברת האשראי";
            console.log("❌ Donation Rejected:", errorMsg);
            res.status(400).json({ success: false, error: errorMsg });
        }
    } catch (e) {
        console.error("❌ Critical Error:", e.message);
        res.status(500).json({ success: false, error: "שגיאת שרת פנימית" });
    }
});
