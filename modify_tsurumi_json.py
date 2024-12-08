# "jreast-tsurumi.json", "jreast-tsurumiokawabranch.json", "jreast-tsurumiumishibaurabranch.json" のタイムテーブルの形式が不正なので修正を行う。

import glob
import json


def main():

    tsurumi_timetables_obj = {}

    # "jreast-tsurumi.json", "jreast-tsurumiokawabranch.json", "jreast-tsurumiumishibaurabranch.json" をオブジェクトとして読み込み
    for path in sorted(glob.glob("data/train-timetables/jreast-tsurumi*.json")):
        with open(path, "r", encoding="UTF-8") as f:
            tsurumi_timetables_obj[path] = json.load(f)

    # オブジェクトを1つずつ処理
    for timetables_obj in tsurumi_timetables_obj.values():
        for timetable_obj in timetables_obj:

            # "tt"の最後の要素が"a"のキーを持っていない場合
            if "a" not in timetable_obj["tt"][-1].keys():

                # 次に運行される列車のID
                next_train_timetable_id = timetable_obj["nt"][0]

                # 次に運行される列車の時刻表のオブジェクトを検索
                next_train_timetable_obj = get_timetable_obj_from_timetable_id(
                    tsurumi_timetables_obj, next_train_timetable_id)

                # 次に運行される列車の最初の駅の到着時間
                arrival_time = next_train_timetable_obj["tt"][0]["d"]

                # "tt"の最後の要素に"d"（到着時刻）のキーを追加
                timetable_obj["tt"][-1]["a"] = arrival_time

    # jsonを上書き
    for path in tsurumi_timetables_obj.keys():
        with open(path, "w", encoding="UTF-8") as f:
            json.dump(tsurumi_timetables_obj[path],
                      f, ensure_ascii=False, indent=4)


# 鶴見線（支線も含む）の列車時刻表が格納されたリストを利用して、時刻表IDと一致する列車時刻表オブジェクトを探索
def get_timetable_obj_from_timetable_id(tsurumi_timetables_obj: dict, timetable_id: str) -> dict:
    # オブジェクトを1つずつ処理
    for timetables_obj in tsurumi_timetables_obj.values():
        for timetable_obj in timetables_obj:
            if timetable_obj["id"] == timetable_id:
                return timetable_obj


if __name__ == "__main__":
    main()
