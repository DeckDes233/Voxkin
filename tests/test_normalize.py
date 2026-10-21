from voxkin.stt.normalize import to_simplified


def test_traditional_is_converted():
    assert to_simplified("這個年紀的孩子褲子是不是應該更高一點才對") == (
        "这个年纪的孩子裤子是不是应该更高一点才对"
    )


def test_simplified_is_unchanged():
    text = "我们一起去挖点泥土吧"
    assert to_simplified(text) == text


def test_empty_text():
    assert to_simplified("") == ""
