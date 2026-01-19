// --- בניית העסקה (מעודכן ל-J5 ועסקה רגילה) ---
        let tranData = {
            Total: parseFloat(amount),
            Currency: 1, 
            CreditType: 1, // שינינו ל-1 (רגיל) במקום 10 (תשלומים) לבדיקה ראשונית
            ParamJ: "J5",  // שינוי קריטי: J5 הוא הפרוטוקול המעודכן יותר
            TransactionType: "debit",
            ProjectNumber: "00001",
            Phone: (phone || user.phone || "0500000000").toString(),
            FirstName: firstName,
            LastName: lastName,
            Mail: email || user.email || "no-email@test.com",
            
            // שדה חובה לטוקן
            customerRef: user._id.toString() 
        };
